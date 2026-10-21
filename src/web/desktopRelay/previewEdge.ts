interface PreviewEdgeContext {
  request: Request;
  env: Record<string, string | undefined>;
}

interface PreviewManifest {
  projectId: string;
  contentType: string;
  status: number;
  size: number;
  headers: Record<string, string>;
  chunks?: { url: string }[];
  bodyBase64?: string;
}

const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const previewRoute = new RegExp(`^/desktop/preview/(${uuidPattern})/([A-Za-z0-9_-]{43})/(.*)$`, 'u');
const allowedHeaders = new Set([
  'content-type', 'content-security-policy', 'access-control-allow-origin',
  'cross-origin-resource-policy', 'x-content-type-options', 'referrer-policy',
  'cache-control', 'etag', 'last-modified', 'accept-ranges', 'content-range',
]);
const maxPreviewBytes = 20 * 1024 * 1024;
const maxChunkBytes = 512 * 1024;

/** Streams project-scoped preview files through the edge, keeping each cloud
 * response below its size limit and preserving ordinary image/script URLs. */
export async function onRequest(context: PreviewEdgeContext): Promise<Response> {
  const request = context.request;
  const url = new URL(request.url);
  const route = previewRoute.exec(url.pathname);
  if (!route || !['GET', 'HEAD'].includes(request.method)) return new Response('页面不存在。', { status: 404 });
  const abort = new AbortController();
  const deadline = Date.now() + 120_000;
  const timeout = setTimeout(() => abort.abort(), 120_000);
  let streaming = false;
  const requestAborted = () => abort.abort();
  const finish = () => {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', requestAborted);
  };
  try {
    // EdgeOne's incoming Request exposes method/url/headers but does not
    // guarantee the standard Request.signal property.
    request.signal?.addEventListener('abort', requestAborted, { once: true });
    const secret = context.env.LUDO_DESKTOP_SECRET;
    if (!secret || secret.length < 32) return new Response('本机工作台尚未连接。', { status: 503 });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`origin:${url.origin}`)));
    const proof = btoa(String.fromCharCode(...signature)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    const upstreamHeaders = { 'x-desktop-public-origin': url.origin, 'x-desktop-public-origin-proof': proof };
    const upstreamOptions: RequestInit = { credentials: 'omit', redirect: 'error', headers: upstreamHeaders, signal: abort.signal };
    const manifestUrl = new URL(url);
    manifestUrl.pathname = url.pathname.replace('/desktop/preview/', '/desktop/preview-manifest/');
    let manifestResponse = await fetch(manifestUrl.href, upstreamOptions);
    if (!manifestResponse.ok) {
      return new Response(request.method === 'HEAD' ? null : await manifestResponse.arrayBuffer(), {
        status: manifestResponse.status,
        headers: { 'Content-Type': manifestResponse.headers.get('content-type') ?? 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    let manifestValue: unknown = await manifestResponse.json();
    let pendingRequestId: string | undefined;
    while (manifestValue && typeof manifestValue === 'object' && 'pending' in manifestValue && manifestValue.pending === true) {
      const pending = manifestValue as Record<string, unknown>;
      if (pending.projectId !== route[1] || typeof pending.requestId !== 'string'
          || !new RegExp(`^${uuidPattern}$`, 'u').test(pending.requestId)
          || (pendingRequestId && pendingRequestId !== pending.requestId) || Date.now() >= deadline) {
        throw new Error('Invalid pending project preview');
      }
      pendingRequestId = pending.requestId;
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => { clearTimeout(timer); reject(new Error('Project preview request cancelled')); };
        const timer = setTimeout(() => { abort.signal.removeEventListener('abort', cancelled); resolve(); }, 1_000);
        abort.signal.addEventListener('abort', cancelled, { once: true });
        if (abort.signal.aborted) cancelled();
      });
      manifestResponse = await fetch(manifestUrl.href, {
        ...upstreamOptions,
        headers: { ...upstreamHeaders, 'x-desktop-preview-request': pendingRequestId },
      });
      if (!manifestResponse.ok) throw new Error('Project preview manifest is unavailable');
      manifestValue = await manifestResponse.json();
    }
    const manifest = manifestValue as PreviewManifest;
    if (manifest.projectId !== route[1] || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || manifest.size > maxPreviewBytes
        || !Number.isInteger(manifest.status) || manifest.status < 200 || manifest.status > 599 || typeof manifest.contentType !== 'string') {
      throw new Error('Invalid project preview manifest');
    }
    const headers = new Headers({ 'Content-Type': manifest.contentType, 'Content-Length': String(manifest.size), 'Cache-Control': 'no-store' });
    for (const [name, value] of Object.entries(manifest.headers ?? {})) {
      if (allowedHeaders.has(name.toLowerCase()) && typeof value === 'string') headers.set(name, value);
    }
    const responseOptions = { status: manifest.status, headers };
    if (typeof manifest.bodyBase64 === 'string') {
      const binary = atob(manifest.bodyBase64);
      const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
      if (bytes.byteLength !== manifest.size) throw new Error('Invalid preview file size');
      return new Response(request.method === 'HEAD' || [204, 205, 304].includes(manifest.status) ? null : bytes, responseOptions);
    }
    const chunks = manifest.chunks;
    if (!Array.isArray(chunks) || !chunks.length || chunks.length > 40) throw new Error('Invalid preview chunks');
    const chunkUrls = chunks.map((chunk, index) => {
      if (typeof chunk.url !== 'string' || !chunk.url.startsWith('/') || chunk.url.startsWith('//')) throw new Error('Invalid preview chunk URL');
      const chunkUrl = new URL(chunk.url, url.origin);
      const chunkPattern = new RegExp(`^/desktop/preview-chunk/${route[1]}/${route[2]}/(${uuidPattern})/${index}$`, 'u');
      if (chunkUrl.origin !== url.origin || chunkUrl.search || chunkUrl.hash || !chunkPattern.test(chunkUrl.pathname)) throw new Error('Invalid project preview chunk URL');
      return chunkUrl.href;
    });
    if (request.method === 'HEAD' || [204, 205, 304].includes(manifest.status)) return new Response(null, responseOptions);
    let received = 0;
    let index = 0;
    async function nextChunk() {
      const response = await fetch(chunkUrls[index++]!, upstreamOptions);
      if (!response.ok) throw new Error('Project preview chunk is unavailable');
      const bytes = new Uint8Array(await response.arrayBuffer());
      received += bytes.byteLength;
      if (bytes.byteLength > maxChunkBytes || received > manifest.size) throw new Error('Invalid preview chunk size');
      return bytes;
    }
    const first = await nextChunk();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(first); },
      async pull(controller) {
        try {
          if (index === chunkUrls.length) {
            if (received !== manifest.size) throw new Error('Incomplete project preview file');
            finish();
            controller.close();
          } else controller.enqueue(await nextChunk());
        } catch (error) { abort.abort(); finish(); controller.error(error); }
      },
      cancel() { abort.abort(); finish(); },
    });
    streaming = true;
    return new Response(stream, responseOptions);
  } catch {
    abort.abort();
    return new Response('游戏文件暂时无法读取，请稍后重试。', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  } finally {
    if (!streaming) finish();
  }
}
