/**
 * Same-origin API proxy resolved at request time (process.env.API_URL), so the web image is
 * environment-agnostic: no rebuild when the API's address changes (Railway private networking, k8s).
 */
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length']);

export async function proxy(req: Request, path: string): Promise<Response> {
  const base = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
  const url = new URL(req.url);
  const target = `${base}${path}${url.search}`;
  const headers = new Headers();
  req.headers.forEach((v, k) => { if (!HOP.has(k.toLowerCase())) headers.set(k, v); });
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  try {
    const res = await fetch(target, {
      method: req.method, headers, redirect: 'manual', cache: 'no-store',
      body: hasBody ? await req.arrayBuffer() : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const out = new Headers();
    res.headers.forEach((v, k) => { if (!HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'set-cookie' && k.toLowerCase() !== 'content-encoding') out.set(k, v); });
    for (const c of (res.headers as any).getSetCookie?.() ?? []) out.append('set-cookie', c);
    return new Response(res.status === 204 || res.status === 304 ? null : await res.arrayBuffer(), { status: res.status, headers: out });
  } catch (e) {
    return Response.json({ message: 'API unavailable' }, { status: 502 });
  }
}
