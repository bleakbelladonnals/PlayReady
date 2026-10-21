interface PreviewMiddlewareContext {
  request: Request;
  env: Record<string, string | undefined>;
  next(options: { headers: Record<string, string> }): Response | Promise<Response>;
}

/** The cloud runtime rewrites request.url to an internal origin. Preserve the
 * public origin at the edge and sign it; caller-supplied headers cannot select
 * a more permissive sandbox policy. Only preview GET/HEAD routes need this. */
export async function middleware(context: PreviewMiddlewareContext) {
  const origin = new URL(context.request.url).origin;
  const secret = context.env.LUDO_DESKTOP_SECRET;
  let proof = '';
  if (secret && secret.length >= 32) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`origin:${origin}`)));
    proof = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  }
  return context.next({ headers: { 'x-desktop-public-origin': origin, 'x-desktop-public-origin-proof': proof } });
}
export const config = { matcher: ['/desktop/preview/:path*'] };
