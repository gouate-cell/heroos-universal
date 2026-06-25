function cleanServer(s) {
  s = String(s || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}

function variants(server) {
  const s = cleanServer(server);
  const out = [];
  if (s) out.push(s);
  if (s.startsWith('http://')) out.push('https://' + s.slice(7));
  if (s.startsWith('https://')) out.push('http://' + s.slice(8));
  return [...new Set(out)];
}

async function getText(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 HeroOS/1.0',
      'Accept': '*/*'
    },
    redirect: 'follow'
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 160)}`);
  return t;
}

function isFakeName(name) {
  const n = String(name || '').trim();
  return !n || /^#+/.test(n) || /NO\s+(MATCH|EVENT)$/i.test(n);
}

function safeChannels(channels, limit = 500) {
  return (channels || [])
    .filter(c => c && c.i && c.t && !isFakeName(c.t))
    .slice(0, limit);
}

function makeChannel(server, user, pass, id, title, group, logo, directUrl) {
  const base = cleanServer(server);
  const hls = `${base}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${id}.m3u8`;
  const ts = `${base}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${id}.ts`;
  const url = directUrl || ts;
  return {
    i: String(id),
    t: title,
    g: group || 'Autres',
    logo: logo || '',
    url,
    hls_url: hls,
    ts_url: ts,
    candidates: [hls, ts, url].filter((v, i, a) => v && a.indexOf(v) === i)
  };
}

function m3uParse(text, server, user, pass) {
  const body = String(text || '').trim();
  if (!/^#EXTM3U/i.test(body)) throw new Error('Réponse non M3U');

  const channels = [];
  let title = '', group = '', logo = '';

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      title = (line.split(',').pop() || '').trim();
      group = (line.match(/group-title="([^"]*)"/i) || [, 'Autres'])[1] || 'Autres';
      logo = (line.match(/tvg-logo="([^"]*)"/i) || [, ''])[1] || '';
      continue;
    }

    if (line.startsWith('#')) continue;

    try {
      const direct = new URL(line, server + '/').toString();
      const m = direct.match(/\/live\/[^/]+\/[^/]+\/(\d+)\.(m3u8|ts)(\?|$)/i);
      const id = m ? m[1] : String(channels.length + 1);
      if (!isFakeName(title)) {
        channels.push(makeChannel(server, user, pass, id, title || `Chaîne ${id}`, group, logo, direct));
      }
    } catch {}

    title = ''; group = ''; logo = '';
  }

  return channels;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const q = event.queryStringParameters || {};
  const user = String(q.username || '').trim();
  const pass = String(q.password || '').trim();
  const limit = Math.max(50, Math.min(parseInt(q.limit || '500', 10) || 500, 1000));
  const serverList = variants(q.server);

  if (!serverList.length || !user || !pass) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'server, username et password requis', channels: [] }) };
  }

  const errors = [];

  for (const server of serverList) {
    try {
      const url = `${server}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_live_streams`;
      const arr = JSON.parse(await getText(url));
      if (!Array.isArray(arr)) throw new Error('API non tableau');

      const allChannels = arr.map(x => makeChannel(
        server,
        user,
        pass,
        x.stream_id || x.id,
        x.name || `Chaîne ${x.stream_id || x.id}`,
        x.category_name || x.category_id || 'Autres',
        x.stream_icon || ''
      ));

      const channels = safeChannels(allChannels, limit);
      if (channels.length) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            server_used: server,
            method: 'api',
            total_available: allChannels.length,
            count: channels.length,
            limited: allChannels.length > channels.length,
            channels
          })
        };
      }
      throw new Error('API vide');
    } catch (e) {
      errors.push(`${server} api: ${e.message || String(e)}`);
    }

    const playlistAttempts = [
      { type: 'm3u', output: 'hls' },        // format exact envoyé par le fournisseur
      { type: 'm3u_plus', output: 'hls' },   // variante Xtream fréquente
      { type: 'm3u_plus', output: 'm3u8' },  // HLS standard
      { type: 'm3u_plus', output: 'ts' },    // MPEG-TS standard
      { type: 'm3u', output: 'm3u8' },
      { type: 'm3u', output: 'ts' }
    ];

    for (const attempt of playlistAttempts) {
      try {
        const url = `${server}/get.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&type=${attempt.type}&output=${attempt.output}`;
        const allChannels = m3uParse(await getText(url), server, user, pass);
        const channels = safeChannels(allChannels, limit);
        if (channels.length) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              server_used: server,
              method: `playlist_${attempt.type}_${attempt.output}`,
              total_available: allChannels.length,
              count: channels.length,
              limited: allChannels.length > channels.length,
              channels
            })
          };
        }
      } catch (e) {
        errors.push(`${server} ${attempt.type} ${attempt.output}: ${e.message || String(e)}`);
      }
    }
  }

  return { statusCode: 502, headers, body: JSON.stringify({ error: 'Impossible de charger le serveur', errors, channels: [] }) };
};
