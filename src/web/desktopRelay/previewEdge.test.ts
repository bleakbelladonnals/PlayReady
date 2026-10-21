import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from './previewEdge';

const origin = 'https://ludo.bleakbelladonna.com';
const projectId = 'b245ad76-0882-4bde-897a-bd3bead80a60';
const requestId = 'd8642829-a681-47f2-9e02-2d2a29aa00e1';
const capability = 'a'.repeat(43);
const secret = 'edge-preview-test-secret-'.repeat(3);
const path = `/desktop/preview/${projectId}/${capability}/public/assets/小鸟.png`;
const chunkPath = (index: number) => `/desktop/preview-chunk/${projectId}/${capability}/${requestId}/${index}`;

function context(method = 'GET', query = '') {
  return { request: new Request(`${origin}${path}${query}`, { method }), env: { LUDO_DESKTOP_SECRET: secret } };
}

function manifest(extra: Record<string, unknown> = {}) {
  return {
    projectId, contentType: 'image/png', status: 200, size: 1,
    headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Set-Cookie': 'forbidden=1' },
    chunks: [{ url: chunkPath(0) }], ...extra,
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('desktop preview edge streaming', () => {
  it('supports the documented EdgeOne incoming Request without a signal property', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(manifest({
      bodyBase64: btoa('x'), chunks: undefined,
    })));
    vi.stubGlobal('fetch', request);
    const edgeContext = context();
    edgeContext.request = { url: edgeContext.request.url, method: 'GET' } as Request;
    const response = await onRequest(edgeContext);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('x');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reuses one pending preview request with its query and preserves the final inline 404 response', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (++calls <= 2) return Response.json({ pending: true, projectId, requestId });
      return Response.json(manifest({
        status: 404, contentType: 'text/plain', size: 7, bodyBase64: btoa('missing'), chunks: undefined,
      }));
    });
    vi.stubGlobal('fetch', request);
    const responsePromise = onRequest(context('GET', '?v=7&level=2'));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await responsePromise;
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('missing');
    expect(request.mock.calls.map(([input]) => String(input))).toEqual(Array(3).fill(
      `${origin}${new URL(`${origin}${path}`).pathname.replace('/desktop/preview/', '/desktop/preview-manifest/')}?v=7&level=2`,
    ));
    expect(new Headers(request.mock.calls[0][1]?.headers).get('x-desktop-preview-request')).toBeNull();
    for (const [, options] of request.mock.calls.slice(1)) {
      const headers = new Headers(options?.headers);
      expect(headers.get('x-desktop-preview-request')).toBe(requestId);
      expect(headers.get('x-desktop-public-origin')).toBe(origin);
      expect(headers.get('x-desktop-public-origin-proof')).toBe(createHmac('sha256', secret).update(`origin:${origin}`).digest('base64url'));
    }
  });

  it('streams a 20MB file through 40 ordered chunks without changing its bytes or exposing owner credentials', async () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const calls: number[] = [];
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/desktop/preview-manifest/')) return Response.json(manifest({
        size: bytes.length, chunks: Array.from({ length: 40 }, (_, index) => ({ url: chunkPath(index) })),
      }));
      const index = Number(url.pathname.split('/').at(-1));
      calls.push(index);
      return new Response(bytes.subarray(index * 512 * 1024, (index + 1) * 512 * 1024));
    });
    vi.stubGlobal('fetch', request);
    const response = await onRequest(context());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(bytes.length));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    const actual = Buffer.from(await response.arrayBuffer());
    expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(calls).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(request.mock.calls.every(([, options]) => options?.credentials === 'omit' && options.redirect === 'error')).toBe(true);
  });

  it('preserves the request query and signs the public origin instead of trusting caller supplied proof', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(manifest({
      contentType: 'text/html', bodyBase64: btoa('x'), chunks: undefined,
      headers: { 'Content-Security-Policy': "sandbox allow-scripts allow-same-origin; connect-src 'none'" },
    })));
    vi.stubGlobal('fetch', request);
    const current = context('GET', '?level=2&v=7');
    current.request.headers.set('x-desktop-public-origin', 'https://attacker.example');
    current.request.headers.set('x-desktop-public-origin-proof', 'forged');
    const response = await onRequest(current);
    expect(await response.text()).toBe('x');
    expect(response.headers.get('Content-Security-Policy')).toContain('allow-same-origin');
    const [input, options] = request.mock.calls[0];
    const requested = new URL(String(input));
    expect(requested.origin).toBe(origin);
    expect(requested.pathname).toBe(new URL(`${origin}${path}`).pathname.replace('/desktop/preview/', '/desktop/preview-manifest/'));
    expect(requested.search).toBe('?level=2&v=7');
    expect(new Headers(options?.headers).get('x-desktop-public-origin')).toBe(origin);
    expect(new Headers(options?.headers).get('x-desktop-public-origin-proof')).toBe(createHmac('sha256', secret).update(`origin:${origin}`).digest('base64url'));
  });

  it('denies a manifest or chunk that belongs to another project or origin before downloading its bytes', async () => {
    for (const value of [
      manifest({ projectId: 'b245ad76-0882-4bde-897a-bd3bead80a61' }),
      manifest({ chunks: [{ url: `https://attacker.example${chunkPath(0)}` }] }),
      manifest({ chunks: [{ url: chunkPath(0).replace(projectId, 'b245ad76-0882-4bde-897a-bd3bead80a61') }] }),
    ]) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
      vi.stubGlobal('fetch', request);
      expect((await onRequest(context())).status).toBe(502);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it('returns HEAD metadata without fetching the file chunks', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(manifest({ size: 512 * 1024, contentType: 'audio/wav' })));
    vi.stubGlobal('fetch', request);
    const response = await onRequest(context('HEAD'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('audio/wav');
    expect(response.headers.get('Content-Length')).toBe(String(512 * 1024));
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('aborts pending chunk requests when the browser cancels the preview stream', async () => {
    let chunkSignal: AbortSignal | null | undefined;
    const request = vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
      if (String(input).includes('/preview-manifest/')) return Response.json(manifest({
        size: 2, chunks: [{ url: chunkPath(0) }, { url: chunkPath(1) }],
      }));
      chunkSignal = options?.signal;
      return new Response(new Uint8Array([1]));
    });
    vi.stubGlobal('fetch', request);
    const response = await onRequest(context());
    await response.body!.cancel();
    expect(chunkSignal?.aborted).toBe(true);
  });
});
