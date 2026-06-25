exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Cache-Control': 'no-store'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  try {
    const target = event.queryStringParameters && event.queryStringParameters.url;
    if (!target || !/^https?:\/\//i.test(target)) return { statusCode: 400, headers: CORS, body: 'Missing url' };
    const upstream = await fetch(target, {
      headers: {
        'User-Agent': event.headers['user-agent'] || 'Mozilla/5.0 HeroPlay/18',
        'Accept': '*/*',
        'Referer': new URL(target).origin + '/'
      },
      redirect: 'follow'
    });
    const contentType = upstream.headers.get('content-type') || 'text/plain; charset=utf-8';
    const body = await upstream.text();
    return { statusCode: upstream.status, headers: { ...CORS, 'Content-Type': contentType }, body };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: 'Proxy error: ' + (e.message || String(e)) };
  }
};

function cleanServer(s) {
  s = String(s || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}
function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }
function serverVariants(server) {
  const s = cleanServer(server);
  if (!s) return [];
  const out = [s];
  if (s.startsWith('http://')) out.push('https://' + s.slice(7));
  if (s.startsWith('https://')) out.push('http://' + s.slice(8));
  return uniq(out);
}
function isFakeTitle(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  if (/^#+\s*[^#]*\s*#+$/.test(s)) return true;
  if (/^[-_=*\s]+$/.test(s)) return true;
  return false;
}
function hlsUrl(server, user, pass, id) { return `${server}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${id}.m3u8`; }
function tsUrl(server, user, pass, id) { return `${server}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${id}.ts`; }
function proxyUrl(url) { return `/stream?url=${encodeURIComponent(url)}`; }
function buildChannel(server, user, pass, id, title, group, logo) {
  const m3u8 = hlsUrl(server, user, pass, id);
  const ts = tsUrl(server, user, pass, id);
  return {
    i: String(id),
    t: String(title || `Chaîne ${id}`).trim(),
    g: String(group || 'Autres'),
    logo: logo || '',
    url: proxyUrl(ts),
    hls_url: proxyUrl(m3u8),
    ts_url: proxyUrl(ts),
    direct_hls_url: m3u8,
    direct_ts_url: ts,
    candidates: [
      { kind: 'ts-proxy', url: proxyUrl(ts) },
      { kind: 'hls-proxy', url: proxyUrl(m3u8) },
      { kind: 'hls-direct', url: m3u8 },
      { kind: 'ts-direct', url: ts }
    ]
  };
}
async function getText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 HeroPlay/18', 'Accept': '*/*', 'Referer': new URL(url).origin + '/' },
    redirect: 'follow'
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 160));
  return text;
}
async function getJson(url) {
  const text = await getText(url);
  try { return JSON.parse(text); } catch { throw new Error('JSON invalide: ' + text.slice(0, 160)); }
}
async function loadApi(server, user, pass) {
  const url = `${server}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_live_streams`;
  const arr = await getJson(url);
  if (!Array.isArray(arr) || !arr.length) throw new Error('player_api vide');
  return arr.map(x => {
    const id = x.stream_id || x.id;
    const title = x.name || x.title || `Chaîne ${id}`;
    if (!id || isFakeTitle(title)) return null;
    return buildChannel(server, user, pass, id, title, x.category_name || x.category_id || 'Autres', x.stream_icon || x.logo || '');
  }).filter(Boolean);
}
function parseM3U(text, server, user, pass) {
  const body = String(text || '').trim();
  if (!/^#EXTM3U/i.test(body)) throw new Error('Réponse non M3U: ' + body.slice(0, 100));
  const out = [];
  let meta = { title: '', group: '', logo: '' };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF:/i.test(line)) {
      const group = line.match(/group-title="([^"]*)"/i);
      const logo = line.match(/tvg-logo="([^"]*)"/i);
      meta.group = group ? group[1] : 'Autres';
      meta.logo = logo ? logo[1] : '';
      meta.title = (line.split(',').pop() || '').trim();
      continue;
    }
    if (line.startsWith('#')) continue;
    const m = line.match(/\/live\/[^/]+\/[^/]+\/(\d+)\.(ts|m3u8)(\?|$)/i);
    if (m && !isFakeTitle(meta.title)) out.push(buildChannel(server, user, pass, m[1], meta.title, meta.group, meta.logo));
    meta = { title: '', group: '', logo: '' };
  }
  return out;
}
async function loadGetPhp(server, user, pass, output) {
  const url = `${server}/get.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&type=m3u_plus&output=${output}`;
  return parseM3U(await getText(url), server, user, pass);
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
  const variants = serverVariants(q.server);
  if (!variants.length || !user || !pass) return { statusCode: 400, headers, body: JSON.stringify({ error: 'server, username et password requis', channels: [] }) };
  const errors = [];
  for (const server of variants) {
    const attempts = [
      ['api', () => loadApi(server, user, pass)],
      ['get_m3u8', () => loadGetPhp(server, user, pass, 'm3u8')],
      ['get_ts', () => loadGetPhp(server, user, pass, 'ts')]
    ];
    for (const [method, fn] of attempts) {
      try {
        const channels = await fn();
        if (channels.length) return { statusCode: 200, headers, body: JSON.stringify({ server_used: server, method, total: channels.length, channels }) };
        errors.push(`${server} ${method}: 0 chaîne`);
      } catch (e) { errors.push(`${server} ${method}: ${e.message || String(e)}`); }
    }
  }
  return { statusCode: 502, headers, body: JSON.stringify({ error: 'Aucune chaîne trouvée', errors, channels: [] }) };
};
