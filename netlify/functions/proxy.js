function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Cache-Control': 'no-store',
    ...extra
  };
}

function proxify(url) {
  return `/.netlify/functions/proxy?url=${encodeURIComponent(url)}`;
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

exports.handler = async (event) => {
  const cors = corsHeaders();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const target = event.queryStringParameters && event.queryStringParameters.url;
    if (!target || !/^https?:\/\//i.test(target)) return { statusCode: 400, headers: cors, body: 'Missing url' };

    const reqHeaders = {
      'User-Agent': event.headers['user-agent'] || 'Mozilla/5.0 HeroOS/1.0',
      'Accept': '*/*',
      'Referer': new URL(target).origin + '/',
      'Origin': new URL(target).origin
    };
    if (event.headers.range) reqHeaders.Range = event.headers.range;

    const res = await fetch(target, { headers: reqHeaders, redirect: 'follow' });
    const ct = res.headers.get('content-type') || '';
    const isPlaylist = /mpegurl|m3u|text\/plain/i.test(ct) || /\.m3u8?(\?|$)/i.test(target);
    const headers = corsHeaders({
      'Content-Type': isPlaylist ? 'application/vnd.apple.mpegurl; charset=utf-8' : (ct || 'application/octet-stream')
    });

    const ar = res.headers.get('accept-ranges');
    const cr = res.headers.get('content-range');
    const cl = res.headers.get('content-length');
    if (ar) headers['Accept-Ranges'] = ar;
    if (cr) headers['Content-Range'] = cr;
    if (cl && !isPlaylist) headers['Content-Length'] = cl;

    if (isPlaylist) {
      const body = rewritePlaylist(await res.text(), target);
      return { statusCode: res.status, headers, body };
    }

    const ab = await res.arrayBuffer();
    return { statusCode: res.status, headers, body: Buffer.from(ab).toString('base64'), isBase64Encoded: true };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: 'Proxy error: ' + (e.message || String(e)) };
  }
};
