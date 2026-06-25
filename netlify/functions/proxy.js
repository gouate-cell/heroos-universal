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
