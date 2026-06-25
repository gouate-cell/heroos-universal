export default async (request) => {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get('url');
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Cache-Control': 'no-store'
  };
  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });
  if (!target || !/^https?:\/\//i.test(target)) return new Response('Missing url', { status: 400, headers: cors });

  const upstreamHeaders = new Headers();
  upstreamHeaders.set('User-Agent', request.headers.get('user-agent') || 'Mozilla/5.0 HeroPlay/18');
  upstreamHeaders.set('Accept', '*/*');
  upstreamHeaders.set('Referer', new URL(target).origin + '/');
  const range = request.headers.get('range');
  if (range) upstreamHeaders.set('Range', range);

  let upstream;
  try {
    upstream = await fetch(target, { headers: upstreamHeaders, redirect: 'follow' });
  } catch (e) {
    return new Response('Stream fetch error: ' + (e.message || String(e)), { status: 502, headers: cors });
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const outHeaders = new Headers(upstream.headers);
  Object.entries(cors).forEach(([k, v]) => outHeaders.set(k, v));

  const isPlaylist = /mpegurl|m3u/i.test(contentType) || /\.m3u8?(\?|$)/i.test(target);
  if (!isPlaylist) return new Response(upstream.body, { status: upstream.status, headers: outHeaders });

  let body = await upstream.text();
  if (/#EXTM3U/i.test(body)) {
    const base = new URL(target);
    body = body.split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#EXT-X-KEY') && t.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="/stream?url=${encodeURIComponent(new URL(u, base).toString())}"`);
      }
      if (t.startsWith('#EXT-X-MAP') && t.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="/stream?url=${encodeURIComponent(new URL(u, base).toString())}"`);
      }
      if (t.startsWith('#')) return line;
      try { return `/stream?url=${encodeURIComponent(new URL(t, base).toString())}`; }
      catch { return line; }
    }).join('\n');
  }
  outHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  return new Response(body, { status: upstream.status, headers: outHeaders });
};
