import { randomUUID } from 'node:crypto';
import type { CloudFunctionContext } from '@edgeone/types';
import { getStore } from '@edgeone/pages-blob';
import { cloudHandler } from '../edgeone/handler.js';
import { publicError, stateCall, type RuntimeEnv } from '../edgeone/rpc.js';
import { WebInputError } from '../server/state.js';
import {
  createOwnerSession, DESKTOP_CHANNELS, DESKTOP_EVENTS, MAX_FILE_BYTES, MAX_RELAY_BYTES, OWNER_COOKIE,
  previewCapability, publicOriginProof, safePreviewPath, secretEqual, validOwnerSession, type RelayKind,
} from './protocol.js';

const gameCsp = "sandbox allow-scripts allow-pointer-lock; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
}
function requireSameOrigin(request: Request, env: RuntimeEnv) {
  const origin = request.headers.get('origin');
  const primary = env.WEB_PUBLIC_ORIGIN || new URL(request.url).origin;
  if (!origin || origin !== primary) throw new WebInputError(403, '请求来源无效。');
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new WebInputError(400, '请求标识无效。');
  return value;
}
function checkedPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WebInputError(400, '请求格式无效。');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RELAY_BYTES) throw new WebInputError(413, '这次传输的文件过大，请减少附件。');
  return value as Record<string, unknown>;
}
async function body(request: CloudFunctionContext['request']) {
  // EdgeOne parses JSON into request.body, while direct Node tests use Request.
  const source = await request!.body;
  return checkedPayload(source instanceof ReadableStream ? await (request as unknown as Request).json() : source);
}
function ensureOwner(request: Request, secret: string) {
  if (!validOwnerSession(request.headers.get('cookie'), secret)) throw new WebInputError(401, '请先连接你的本机工作台。');
}
export async function desktopCloudHandler(context: CloudFunctionContext): Promise<Response> {
  const request = context.request;
  if (!request) return json({ error: '页面不存在。' }, 404);
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/desktop/')) return cloudHandler(context);
  try {
    const secret = context.env.LUDO_DESKTOP_SECRET;
    if (!secret || secret.length < 32) throw new WebInputError(503, '本机工作台尚未连接。');
    const workerUpload = /^\/desktop\/worker\/upload\/([a-f0-9-]{36})\/(\d{1,4})$/u.exec(url.pathname);
    if (workerUpload && request.method === 'GET') {
      if (!secretEqual(request.headers.get('authorization')?.replace(/^Bearer /u, ''), secret)) throw new WebInputError(403, '工作台连接未获授权。');
      const id = identifier(workerUpload[1]), index = Number(workerUpload[2]);
      if (index > 1023) throw new WebInputError(400, '附件分段标识无效。');
      const bytes = await getStore('ludoready-projects').get(uploadKey(id, index), { type: 'arrayBuffer', consistency: 'strong' }) as ArrayBuffer | null;
      if (!bytes) throw new WebInputError(404, '附件分段不存在。');
      return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (url.pathname === '/desktop/worker' && request.method === 'POST') {
      if (!secretEqual(request.headers.get('authorization')?.replace(/^Bearer /u, ''), secret)) throw new WebInputError(403, '工作台连接未获授权。');
      const input = await body(request);
      identifier(input.workerId);
      if (!['poll', 'heartbeat', 'complete', 'events', 'binary-put'].includes(String(input.op))) throw new WebInputError(400, '请求操作无效。');
      if (input.op === 'binary-put') {
        const id = identifier(input.id);
        if (!Number.isSafeInteger(input.index) || Number(input.index) < 0 || Number(input.index) > 1023
            || typeof input.data !== 'string' || input.data.length > 512 * 1024 * 4 / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.data)) throw new WebInputError(400, '文件分段格式无效。');
        await stateCall(context.env, 'desktop-heartbeat', { workerId: input.workerId });
        await getStore('ludoready-projects').set(binaryKey(id, Number(input.index)), Uint8Array.from(Buffer.from(input.data, 'base64')).buffer);
        return json({ ok: true });
      }
      if (input.op === 'complete') {
        identifier(input.id);
        if (input.error !== undefined && (typeof input.error !== 'string' || input.error.length > 4000)) throw new WebInputError(400, '任务结果格式无效。');
      }
      if (input.op === 'events' && (!Array.isArray(input.events) || input.events.length > 100 || input.events.some((event) => !event || typeof event !== 'object' || !DESKTOP_EVENTS.has(event.channel)))) throw new WebInputError(400, '任务更新格式无效。');
      const { op, ...payload } = input;
      return json(await stateCall(context.env, `desktop-${String(op)}`, payload));
    }
    if (request.method === 'POST') requireSameOrigin(request as unknown as Request, context.env);
    if (url.pathname === '/desktop/connect' && request.method === 'POST') {
      const input = await body(request);
      if (!secretEqual(input.token, secret)) throw new WebInputError(403, '工作台连接码不正确。');
      return json({ connected: true }, 200, { 'Set-Cookie': `${OWNER_COOKIE}=${createOwnerSession(secret)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400` });
    }
    const previewChunk = /^\/desktop\/preview-chunk\/([a-f0-9-]{36})\/([A-Za-z0-9_-]{43})\/([a-f0-9-]{36})\/(\d{1,2})$/u.exec(url.pathname);
    if (previewChunk && request.method === 'GET') {
      const projectId = identifier(previewChunk[1]), id = identifier(previewChunk[3]), index = Number(previewChunk[4]);
      if (!secretEqual(previewChunk[2], previewCapability(projectId, secret))) throw new WebInputError(404, '游戏文件分段不存在。');
      const metadata = await getStore('ludoready-projects').get(previewMetadataKey(id), { type: 'json', consistency: 'strong' }) as { projectId?: string; binaryParts?: number } | null;
      if (!metadata || metadata.projectId !== projectId || !Number.isSafeInteger(metadata.binaryParts) || index >= metadata.binaryParts!) throw new WebInputError(404, '游戏文件分段不存在。');
      const bytes = await getStore('ludoready-projects').get(binaryKey(id, index), { type: 'arrayBuffer', consistency: 'strong' }) as ArrayBuffer | null;
      if (!bytes || bytes.byteLength > 512 * 1024) throw new WebInputError(404, '游戏文件分段不存在。');
      return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    const preview = /^\/desktop\/(preview|preview-manifest)\/([a-f0-9-]{36})\/(?:([A-Za-z0-9_-]{43})\/)?(.*)$/u.exec(url.pathname);
    if (preview && ['GET', 'HEAD'].includes(request.method)) {
      const projectId = identifier(preview[2]);
      if (!preview[3] || !secretEqual(preview[3], previewCapability(projectId, secret))) ensureOwner(request as unknown as Request, secret);
      const path = safePreviewPath(preview[4]!);
      if (!path) throw new WebInputError(404, '游戏文件不存在。');
      const signedOrigin = request.headers.get('x-desktop-public-origin');
      const proof = request.headers.get('x-desktop-public-origin-proof');
      const publicOrigin = signedOrigin && secretEqual(proof, publicOriginProof(signedOrigin, secret))
        ? signedOrigin : context.env.WEB_PUBLIC_ORIGIN;
      return await binaryRequest(context.env, 'preview', [projectId, `${path}${url.search}`], request.method === 'HEAD', publicOrigin, preview[1] === 'preview-manifest', request.headers.get('x-desktop-preview-request') ?? undefined);
    }
    ensureOwner(request as unknown as Request, secret);
    if (url.pathname === '/desktop/disconnect' && request.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': `${OWNER_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });
    if (url.pathname === '/desktop/events' && request.method === 'GET') {
      const cursor = Number(url.searchParams.get('after') ?? url.searchParams.get('cursor') ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new WebInputError(400, '任务更新位置无效。');
      return json(await stateCall(context.env, 'desktop-read-events', { cursor, latest: url.searchParams.get('latest') === '1' }));
    }
    const result = /^\/desktop\/result\/([a-f0-9-]{36})$/u.exec(url.pathname);
    if (result && request.method === 'GET') {
      const id = identifier(result[1]);
      const value = await stateCall<{ pending: boolean; result?: JsonPartsResult }>(context.env, 'desktop-result', { id });
      if (!value.pending && value.result && Number.isSafeInteger(value.result.jsonParts)) {
        const bytes = await readBinaryParts(id, value.result.jsonParts!, value.result.size!);
        let decoded: unknown;
        try { decoded = JSON.parse(bytes.toString('utf8')); } catch { throw new WebInputError(502, '工作台返回内容不完整，请重新操作。'); }
        return json({ ...value, result: decoded });
      }
      return json(value);
    }
    const downloadChunk = /^\/desktop\/download-chunk\/([a-f0-9-]{36})\/(\d{1,4})$/u.exec(url.pathname);
    if (downloadChunk && request.method === 'GET') {
      const id = identifier(downloadChunk[1]), index = Number(downloadChunk[2]);
      const value = await stateCall<{ pending: boolean; result?: BinaryResult }>(context.env, 'desktop-result', { id });
      if (value.pending || !validParts(value.result) || index >= value.result!.binaryParts!) throw new WebInputError(404, '下载分段不存在。');
      const bytes = await getStore('ludoready-projects').get(binaryKey(id, index), { type: 'arrayBuffer', consistency: 'strong' }) as ArrayBuffer | null;
      if (!bytes) throw new WebInputError(404, '下载分段不存在。');
      return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (url.pathname === '/desktop/rpc' && request.method === 'POST') {
      const input = await body(request);
      if (typeof input.channel !== 'string' || !DESKTOP_CHANNELS.has(input.channel) || !Array.isArray(input.args) || input.args.length > 10) throw new WebInputError(400, '工作台操作无效。');
      return json(await submit(context.env, 'rpc', input.channel, input.args));
    }
    if (url.pathname === '/desktop/upload-part' && request.method === 'POST') {
      const input = await body(request);
      const id = identifier(input.id);
      if (!Number.isSafeInteger(input.count) || Number(input.count) < 1 || Number(input.count) > 64
          || !Number.isSafeInteger(input.index) || Number(input.index) < 0 || Number(input.index) >= Number(input.count)
          || typeof input.dataBase64 !== 'string' || input.dataBase64.length > 512 * 1024 * 4 / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.dataBase64)) throw new WebInputError(400, '附件分段格式无效。');
      const bytes = Buffer.from(input.dataBase64, 'base64');
      if (!bytes.length || bytes.length > 512 * 1024) throw new WebInputError(400, '附件分段格式无效。');
      await getStore('ludoready-projects').set(uploadKey(id, Number(input.index)), Uint8Array.from(bytes).buffer);
      return json({ ok: true });
    }
    if (url.pathname === '/desktop/upload' && request.method === 'POST') {
      const input = await body(request);
      if (input.uploadParts !== undefined) {
        const uploadParts = identifier(input.uploadParts);
        if (!Number.isSafeInteger(input.count) || Number(input.count) < 1 || Number(input.count) > 64) throw new WebInputError(400, '附件分段清单无效。');
        return json(await submit(context.env, 'upload', '', [{ uploadParts, count: input.count }]));
      }
      if (!Array.isArray(input.files) || !input.files.length || input.files.length > 50 || input.files.some((file) => !file || typeof file.name !== 'string' || file.name.length > 255 || typeof file.data !== 'string' || file.data.length > MAX_FILE_BYTES * 4 / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(file.data))) throw new WebInputError(400, '附件格式无效或过大。');
      // The state gateway only accepts small JSON requests. Keep the attachment
      // bytes in private Blob storage and queue a tiny manifest instead.
      const uploadId = randomUUID();
      const bytes = Buffer.from(JSON.stringify(input));
      const count = Math.ceil(bytes.length / (512 * 1024));
      for (let index = 0; index < count; index++) {
        await getStore('ludoready-projects').set(uploadKey(uploadId, index), Uint8Array.from(bytes.subarray(index * 512 * 1024, (index + 1) * 512 * 1024)).buffer);
      }
      return json(await submit(context.env, 'upload', '', [{ uploadParts: uploadId, count }]));
    }
    const download = /^\/desktop\/download\/([a-f0-9-]{36})$/u.exec(url.pathname);
    if (download && request.method === 'GET') return await binaryRequest(context.env, 'download', [identifier(download[1])]);
    throw new WebInputError(404, '页面不存在。');
  } catch (error) {
    const failure = error instanceof WebInputError ? { status: error.status, error: error.message } : publicError(error);
    return json({ error: failure.error }, failure.status);
  }
}
async function submit(env: RuntimeEnv, kind: RelayKind, channel: string, args: unknown[]) {
  const requestId = randomUUID();
  await stateCall(env, 'desktop-submit', { id: requestId, kind, channel, args });
  return { requestId };
}
interface BinaryResult { bodyBase64?: string; binaryParts?: number; size?: number; contentType?: string; status?: number }
interface JsonPartsResult { jsonParts?: number; size?: number }
function binaryKey(id: string, index: number) { return `desktop-files/${id}/${index}`; }
function uploadKey(id: string, index: number) { return `desktop-uploads/${id}/${index}`; }
function previewMetadataKey(id: string) { return `desktop-preview/${id}/metadata.json`; }
async function readBinaryParts(id: string, count: number, size: number): Promise<Buffer> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 8 || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new WebInputError(413, '工作台返回内容过大，请在本机查看这个文件。');
  const parts = await Promise.all(Array.from({ length: count }, (_, index) => getStore('ludoready-projects').get(binaryKey(id, index), { type: 'arrayBuffer', consistency: 'strong' })));
  if (parts.some((part) => !(part instanceof ArrayBuffer))) throw new WebInputError(404, '工作台返回内容分段不完整。');
  const bytes = Buffer.concat(parts.map((part) => Buffer.from(part as ArrayBuffer)));
  if (bytes.length !== size) throw new WebInputError(502, '工作台返回内容不完整，请重新操作。');
  return bytes;
}
function validParts(value: BinaryResult | undefined): boolean {
  return !!value && Number.isSafeInteger(value.binaryParts) && value.binaryParts! > 0 && value.binaryParts! <= 1024;
}
async function binaryRequest(env: RuntimeEnv, kind: 'preview' | 'download', args: unknown[], head = false, requestOrigin = env.WEB_PUBLIC_ORIGIN, manifestOnly = false, existingId?: string) {
  let requestId: string;
  if (manifestOnly && existingId) {
    requestId = identifier(existingId);
    const metadata = await getStore('ludoready-projects').get(previewMetadataKey(requestId), { type: 'json', consistency: 'strong' }) as { projectId?: string; path?: string } | null;
    if (!metadata || metadata.projectId !== args[0] || metadata.path !== args[1]) throw new WebInputError(404, '游戏文件请求不存在。');
  } else {
    ({ requestId } = await submit(env, kind, '', args));
    if (manifestOnly) await getStore('ludoready-projects').setJSON(previewMetadataKey(requestId), { projectId: args[0], path: args[1] });
  }
  const deadline = Date.now() + 16_000;
  while (Date.now() < deadline) {
    const value = await stateCall<{ pending: boolean; result?: BinaryResult; error?: string }>(env, 'desktop-result', { id: requestId });
    if (!value.pending) {
      if (value.error) throw new WebInputError(503, value.error);
      if (!value.result || !validParts(value.result) && typeof value.result.bodyBase64 !== 'string') throw new WebInputError(502, '游戏文件返回格式无效。');
      if (kind === 'download' && validParts(value.result)) return json({
        filename: `ludoready-${String(args[0])}.zip`,
        chunks: Array.from({ length: value.result.binaryParts! }, (_, index) => ({ url: `/desktop/download-chunk/${requestId}/${index}` })),
      });
      const contentType = value.result.contentType || 'application/octet-stream';
      const status = value.result.status && value.result.status >= 400 && value.result.status <= 599 ? value.result.status : 200;
      const previewSource = requestOrigin && env.LUDO_DESKTOP_SECRET
        ? `${requestOrigin}/desktop/preview/${String(args[0])}/${previewCapability(String(args[0]), env.LUDO_DESKTOP_SECRET)}/` : null;
      const isolatedOrigin = !!env.WEB_PUBLIC_ORIGIN && !!requestOrigin && requestOrigin !== env.WEB_PUBLIC_ORIGIN;
      const previewCsp = isolatedOrigin ? gameCsp.replace('sandbox allow-scripts', 'sandbox allow-same-origin allow-scripts') : gameCsp;
      const csp = previewSource ? previewCsp.replace("connect-src 'none'", `connect-src ${previewSource}`) : previewCsp;
      const headers: Record<string, string> = {
        'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
        ...(contentType.startsWith('text/html') ? { 'Content-Security-Policy': csp } : {}),
        ...(kind === 'download' ? { 'Content-Disposition': `attachment; filename="ludoready-${String(args[0])}.zip"` } : {}),
      };
      if (manifestOnly) {
        const projectId = String(args[0]);
        if (validParts(value.result)) {
          if (value.result.binaryParts! > 40 || !Number.isSafeInteger(value.result.size) || value.result.size! < 0 || value.result.size! > 20 * 1024 * 1024) throw new WebInputError(413, '游戏素材需要在 20 MB 以内。');
          await getStore('ludoready-projects').setJSON(previewMetadataKey(requestId), { projectId, path: args[1], binaryParts: value.result.binaryParts });
          const capability = previewCapability(projectId, env.LUDO_DESKTOP_SECRET!);
          return json({ projectId, contentType, status, size: value.result.size, headers,
            chunks: Array.from({ length: value.result.binaryParts! }, (_, index) => ({ url: `/desktop/preview-chunk/${projectId}/${capability}/${requestId}/${index}` })),
          });
        }
        const bytes = Buffer.from(value.result.bodyBase64!, 'base64');
        if (bytes.length > 32 * 1024) throw new WebInputError(502, '游戏素材未按分段格式返回。');
        return json({ projectId, contentType, status, size: bytes.length, headers, bodyBase64: value.result.bodyBase64 });
      }
      let bytes: Buffer;
      if (validParts(value.result)) bytes = await readBinaryParts(requestId, value.result.binaryParts!, value.result.size!);
      else bytes = Buffer.from(value.result.bodyBase64!, 'base64');
      if (bytes.length > MAX_FILE_BYTES) throw new WebInputError(413, '游戏文件过大，暂时无法通过网页传输。');
      return new Response(head ? null : Uint8Array.from(bytes).buffer, { status, headers });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (manifestOnly) return json({ pending: true, projectId: args[0], requestId });
  throw new WebInputError(503, '本机工作台未及时返回游戏文件，请确认电脑处于运行状态。');
}
