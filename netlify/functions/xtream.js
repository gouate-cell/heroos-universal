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
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 140)}`);
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

function m3uParse(text, server, user, pass) {
  const body = String(text || '').trim();
  if (!/^#EXTM3U/i.test(body)) throw new Error('Réponse non M3U');

  const channels = [];
  let title = '';
  let group = '';
  let logo = '';

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
      const url = new URL(line, server + '/').toString();
      const m = url.match(/\/live\/[^/]+\/[^/]+\/(\d+)\.(m3u8|ts)(\?|$)/i);
      const id = m ? m[1] : String(channels.length + 1);

      if (!isFakeName(title)) {
        channels.push(
          makeChannel(
            server,
            user,
            pass,
            id,
            title || `Chaîne ${id}`,
            group,
            logo,
            url
          )
        );
      }
    } catch {}

    title = '';
    group = '';
    logo = '';
  }

  return channels;
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
    candidates: [ts, hls, url].filter((v, i, a) => v && a.indexOf(v) === i)
  };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const q = event.queryStringParameters || {};
  const user = String(q.username || '').trim();
  const pass = String(q.password || '').trim();
  const serverList = variants(q.server);

  if (!serverList.length || !user || !pass) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'server, username et password requis',
        channels: []
      })
    };
  }

  const errors = [];

  for (const server of serverList) {
    try {
      const url = `${server}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_live_streams`;
      const arr = JSON.parse(await getText(url));

      if (!Array.isArray(arr)) throw new Error('API non tableau');

      const allChannels = arr.map(x =>
        makeChannel(
          server,
          user,
          pass,
          x.stream_id || x.id,
          x.name || `Chaîne ${x.stream_id || x.id}`,
          x.category_name || x.category_id || 'Autres',
          x.stream_icon || ''
        )
      );

      const channels = safeChannels(allChannels, 500);

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
      errors.push(`${server} api: ${e.message}`);
    }

    for (const out of ['ts', 'm3u8']) {
      try {
        const url = `${server}/get.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&type=m3u_plus&output=${out}`;
        const allChannels = m3uParse(await getText(url), server, user, pass);
        const channels = safeChannels(allChannels, 500);

        if (channels.length) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              server_used: server,
              method: 'm3u_' + out,
              total_available: allChannels.length,
              count: channels.length,
              limited: allChannels.length > channels.length,
              channels
            })
          };
        }
      } catch (e) {
        errors.push(`${server} m3u ${out}: ${e.message}`);
      }
    }
  }

  return {
    statusCode: 502,
    headers,
    body: JSON.stringify({
      error: 'Impossible de charger le serveur',
      errors,
      channels: []
    })
  };
};
