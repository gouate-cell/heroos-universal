function proxify(url) {
  return `/stream?url=${encodeURIComponent(url)}`;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Cache-Control': 'no-store'
  };
}

function rewritePlaylist(body, target) {
  const base = new URL(target);
  return String(body || '').split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;

    if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP') || t.startsWith('#EXT-X-I-FRAME-STREAM-INF') || t.startsWith('#EXT-X-MEDIA')) {
      return line.replace(/URI="([^"]+)"/g, (_, u) => {
        try { return `URI="${proxify(new URL(u, base).toString())}"`; } catch { return `URI="${u}"`; }
      });
    }

    if (t.startsWith('#')) return line;

    try {
      return proxify(new URL(t, base).toString());
    } catch {
      return line;
    }
  }).join('\n');
}

export default async (request) => {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get('url');
  const cors = corsHeaders();

  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });
  if (!target || !/^https?:\/\//i.test(target)) return new Response('Missing url', { status: 400, headers: cors });

  const upstreamHeaders = new Headers();
  upstreamHeaders.set('User-Agent', request.headers.get('user-agent') || 'Mozilla/5.0 HeroOS/1.0');
  upstreamHeaders.set('Accept', '*/*');
  upstreamHeaders.set('Referer', new URL(target).origin + '/');
  upstreamHeaders.set('Origin', new URL(target).origin);
  const range = request.headers.get('range');
  if (range) upstreamHeaders.set('Range', range);

  let upstream;
  try {
    upstream = await fetch(target, { headers: upstreamHeaders, redirect: 'follow' });
  } catch (e) {
    return new Response('Stream fetch error: ' + (e.message || String(e)), { status: 502, headers: cors });
  }

  const out = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(cors)) out.set(k, v);

  const ct = upstream.headers.get('content-type') || '';
  const isPlaylist = /mpegurl|m3u|text\/plain/i.test(ct) || /\.m3u8?(\?|$)/i.test(target);

  if (isPlaylist) {
    const body = rewritePlaylist(await upstream.text(), target);
    out.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    out.delete('Content-Length');
    return new Response(body, { status: upstream.status, headers: out });
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
};
