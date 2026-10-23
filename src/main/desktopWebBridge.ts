import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

export interface DesktopWebEvent { id: number; channel: string; payload: unknown }
export interface DesktopWebCommand { id: string; channel?: string; args: unknown[]; kind?: string }
export interface DesktopWebBinary { bodyBase64: string; contentType: string; status?: number }
export interface DesktopWebOptions {
  rendererRoot: string;
  uploadRoot: string;
  token: string;
  port?: number;
  remoteOrigin?: string;
  workerId?: string;
  invoke: (channel: string, args: unknown[], remote?: boolean) => Promise<unknown>;
  preview: (projectId: string, path: string) => Promise<DesktopWebBinary>;
  download: (projectId: string) => Promise<DesktopWebBinary>;
  diagnostic?: (message: string) => void;
}
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const cookieName = 'ludoready_desktop';
const uploadExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.ogg', '.glb', '.pdf', '.md', '.txt', '.json', '.csv']);
const activePollMs = 1000;
const idlePollMs = 10_000;

/** Authenticated browser transport around the actual desktop handlers. No Codex RPC is exposed. */
export class DesktopWebBridge {
  readonly #options: DesktopWebOptions;
  readonly #events: DesktopWebEvent[] = [];
  readonly #remoteEvents: Array<{ channel: string; payload: unknown }> = [];
  readonly #inflight = new Set<Promise<void>>();
  #cursor = 0;
  #server: Server | null = null;
  #controller = new AbortController();
  #remoteLoop: Promise<void> | null = null;
  #wakeIdleRemote: (() => void) | null = null;
  #origin = '';
  constructor(options: DesktopWebOptions) {
    if (options.token.length < 32) throw new Error('桌面连接密钥无效');
    this.#options = options;
    if (options.remoteOrigin && new URL(options.remoteOrigin).protocol !== 'https:') throw new Error('远程连接必须使用 HTTPS');
  }
  get origin(): string { return this.#origin; }
  get connectUrl(): string { return `${this.#origin}/#connect=${encodeURIComponent(this.#options.token)}`; }
  connectRemote(origin: string): void {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('远程工作台需要 HTTPS 网站地址');
    if (this.#remoteLoop) {
      if (this.#options.remoteOrigin !== origin) throw new Error('请重启桌面后台以切换网站');
      return;
    }
    this.#options.remoteOrigin = origin;
    this.#remoteEvents.push(...this.#events.map(({ channel, payload }) => ({ channel, payload })));
    this.#remoteLoop = this.#runRemote();
  }
  publish(channel: string, payload: unknown): void {
    this.#events.push({ id: ++this.#cursor, channel, payload });
    if (this.#events.length > 2000) this.#events.splice(0, this.#events.length - 2000);
    if (this.#options.remoteOrigin) {
      this.#remoteEvents.push({ channel, payload });
      this.#wakeIdleRemote?.();
    }
  }
  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        if (!response.headersSent) json(response, 400, { error: message(error) });
        else response.end();
      });
    });
    this.#server = server;
    await new Promise<void>((yes, no) => {
      server.once('error', no);
      server.listen(this.#options.port ?? 8790, '127.0.0.1', () => { server.removeListener('error', no); yes(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('桌面网页无法启动');
    this.#origin = `http://127.0.0.1:${address.port}`;
    if (this.#options.remoteOrigin) this.#remoteLoop = this.#runRemote();
  }
  async stop(): Promise<void> {
    this.#controller.abort();
    this.#server?.closeAllConnections();
    await Promise.allSettled([
      new Promise<void>((yes) => this.#server ? this.#server.close(() => yes()) : yes()),
      this.#remoteLoop,
    ]);
  }
  previewUrl(projectId: string): string {
    return `/desktop/preview/${projectId}/${previewCapability(projectId, this.#options.token)}/`;
  }
  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.#origin);
    if (request.headers.host !== new URL(this.#origin).host) { json(response, 403, { error: '请求来源无效' }); return; }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (request.method === 'POST' && request.headers.origin !== this.#origin) { json(response, 403, { error: '请求来源无效' }); return; }
    if (url.pathname === '/desktop/connect' && request.method === 'POST') {
      const input = await body(request);
      if (!equal(input.token, this.#options.token)) { json(response, 401, { error: '连接密钥不正确' }); return; }
      response.setHeader('Set-Cookie', `${cookieName}=${session(this.#options.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
      json(response, 200, { connected: true }); return;
    }
    const preview = /^\/desktop\/preview\/([a-f0-9-]{36})\/([A-Za-z0-9_-]{43})\/(.*)$/u.exec(url.pathname);
    if (preview && ['GET', 'HEAD'].includes(request.method ?? '')) {
      if (!equal(preview[2], previewCapability(preview[1]!, this.#options.token))) { json(response, 403, { error: '试玩链接无效' }); return; }
      await this.#sendBinary(response, await this.#options.preview(preview[1]!, `${preview[3] || 'index.html'}${url.search}`), request.method === 'HEAD', true, `${this.#origin}${this.previewUrl(preview[1]!)}`);
      return;
    }
    if (url.pathname.startsWith('/desktop/')) {
      const value = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!equal(value, session(this.#options.token))) { json(response, 401, { error: '请先连接你的桌面后台' }); return; }
      if (url.pathname === '/desktop/events' && request.method === 'GET') {
        if (url.searchParams.get('latest') === '1') { json(response, 200, { events: [], cursor: this.#cursor, connected: true }); return; }
        const requestedAfter = Math.max(0, Number(url.searchParams.get('after')) || 0);
        const after = requestedAfter > this.#cursor ? 0 : requestedAfter;
        json(response, 200, { events: this.#events.filter((item) => item.id > after), cursor: this.#cursor, connected: true }); return;
      }
      if (url.pathname === '/desktop/rpc' && request.method === 'POST') {
        const input = await body(request);
        if (typeof input.channel !== 'string' || !Array.isArray(input.args)) throw new Error('无效的桌面操作');
        const result = await this.#options.invoke(input.channel, input.args);
        json(response, 200, { result: result ?? null }); return;
      }
      if (url.pathname === '/desktop/upload' && request.method === 'POST') {
        json(response, 200, { result: await this.#upload(await body(request)) }); return;
      }
      if (url.pathname === '/desktop/remote' && request.method === 'POST') {
        const input = await body(request);
        if (typeof input.origin !== 'string') throw new Error('网站地址无效');
        this.connectRemote(input.origin);
        json(response, 200, { connected: true }); return;
      }
      const download = /^\/desktop\/download\/([a-f0-9-]{36})$/u.exec(url.pathname);
      if (download && request.method === 'GET') {
        response.setHeader('Content-Disposition', `attachment; filename="ludoready-${download[1]}.zip"`);
        await this.#sendBinary(response, await this.#options.download(download[1]!), false, false); return;
      }
      json(response, 404, { error: '操作不存在' }); return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { json(response, 405, { error: '操作不存在' }); return; }
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw new Error('无效的文件路径'); }
    const root = await realpath(this.#options.rendererRoot);
    const candidate = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!contained(root, candidate)) throw new Error('无效的文件路径');
    let path: string;
    try { path = await realpath(candidate); } catch { json(response, 404, { error: '文件不存在' }); return; }
    if (!contained(root, path) || !(await stat(path)).isFile()) { json(response, 404, { error: '文件不存在' }); return; }
    if (extname(path) === '.html') {
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://127.0.0.1:*; media-src 'self' data: blob: http://127.0.0.1:*; font-src 'self' data:; connect-src 'self'; frame-src 'self' http://127.0.0.1:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    }
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    response.end(request.method === 'HEAD' ? undefined : await readFile(path));
  }
  async #upload(input: Record<string, unknown>): Promise<{ paths: string[] }> {
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 50) throw new Error('一次上传 1–50 个附件');
    const directory = join(this.#options.uploadRoot, randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const paths: string[] = [];
    let total = 0;
    for (const raw of input.files) {
      const file = raw as { name?: unknown; data?: unknown };
      if (typeof file?.name !== 'string' || basename(file.name) !== file.name || file.name.includes('\\') || file.name.length > 180 || !uploadExtensions.has(extname(file.name).toLowerCase())) throw new Error('不支持的附件文件名或格式');
      if (typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(file.data)) throw new Error('附件内容无效');
      const bytes = Buffer.from(file.data, 'base64');
      total += bytes.length;
      if (!bytes.length || total > 20 * 1024 * 1024) throw new Error('附件总大小需要在 20 MB 以内');
      const path = join(directory, `${paths.length}-${file.name}`);
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
      paths.push(path);
    }
    return { paths };
  }
  async #sendBinary(response: ServerResponse, value: DesktopWebBinary, head: boolean, preview: boolean, previewSource = ''): Promise<void> {
    response.statusCode = value.status ?? 200;
    response.setHeader('Content-Type', value.contentType);
    if (preview && value.contentType.startsWith('text/html')) response.setHeader('Content-Security-Policy', `sandbox allow-scripts allow-pointer-lock; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src ${previewSource}; form-action 'none'; base-uri 'self'`);
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.end(head ? undefined : Buffer.from(value.bodyBase64, 'base64'));
  }
  async #remote(op: string, input: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const result = await fetch(`${this.#options.remoteOrigin}/desktop/worker`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#options.token}` },
      body: JSON.stringify({ op, workerId: this.#options.workerId ?? 'desktop', ...input }),
      signal: AbortSignal.any([this.#controller.signal, AbortSignal.timeout(25_000)]), redirect: 'error',
    });
    if (!result.ok) throw new Error(`桌面云连接暂时不可用 (${result.status})`);
    return await result.json() as Record<string, any>;
  }
  async #runRemote(): Promise<void> {
    let lastDiagnostic = '';
    let lastEventDiagnostic = '';
    while (!this.#controller.signal.aborted) {
      let active = true;
      try {
        const value = await this.#remote('poll');
        const requests = value.requests ?? [];
        for (const command of requests) {
          const run = this.#executeRemote(command as DesktopWebCommand);
          this.#inflight.add(run);
          void run.finally(() => this.#inflight.delete(run));
        }
        lastDiagnostic = '';
        const hadEvents = this.#remoteEvents.length > 0;
        if (this.#remoteEvents.length) {
          const events = desktopEventBatch(this.#remoteEvents);
          try {
            await this.#remote('events', { events });
            this.#remoteEvents.splice(0, events.length);
            lastEventDiagnostic = '';
          } catch (error) {
            const detail = message(error);
            if (!this.#controller.signal.aborted && detail !== lastEventDiagnostic) this.#options.diagnostic?.(`制作记录传输等待恢复：${detail}`);
            lastEventDiagnostic = detail;
          }
        }
        active = requests.length > 0 || this.#inflight.size > 0 || hadEvents || this.#remoteEvents.length > 0;
      } catch (error) {
        const detail = message(error);
        if (!this.#controller.signal.aborted && detail !== lastDiagnostic) this.#options.diagnostic?.(detail);
        lastDiagnostic = detail;
      }
      if (active) await pause(activePollMs, this.#controller.signal);
      else await this.#pauseIdleRemote();
    }
  }
  async #pauseIdleRemote(): Promise<void> {
    const signal = this.#controller.signal;
    if (signal.aborted || this.#remoteEvents.length) return;
    await new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        if (this.#wakeIdleRemote === finish) this.#wakeIdleRemote = null;
        done();
      };
      const timer = setTimeout(finish, idlePollMs);
      this.#wakeIdleRemote = finish;
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  async #executeRemote(command: DesktopWebCommand): Promise<void> {
    let answer: Record<string, unknown>;
    try {
      let result: unknown;
      if (command.kind === 'upload') {
        let input = command.args[0] as Record<string, unknown>;
        if (typeof input.uploadParts === 'string' && /^[a-f0-9-]{36}$/u.test(input.uploadParts) && Number.isSafeInteger(input.count) && Number(input.count) > 0 && Number(input.count) <= 64) {
          const parts: Buffer[] = [];
          for (let index = 0; index < Number(input.count); index++) {
            const response = await fetch(`${this.#options.remoteOrigin}/desktop/worker/upload/${input.uploadParts}/${index}`, {
              headers: { Authorization: `Bearer ${this.#options.token}` }, redirect: 'error',
              signal: AbortSignal.any([this.#controller.signal, AbortSignal.timeout(25_000)]),
            });
            if (!response.ok) throw new Error('附件传输暂时不可用');
            parts.push(Buffer.from(await response.arrayBuffer()));
          }
          input = JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>;
        }
        result = await this.#upload(input);
      }
      else if (command.kind === 'preview') result = await this.#options.preview(String(command.args[0]), String(command.args[1]));
      else if (command.kind === 'download') result = await this.#options.download(String(command.args[0]));
      else result = await this.#options.invoke(command.channel ?? '', command.args, true);
      if (result && typeof result === 'object' && 'bodyBase64' in result) {
        const binary = result as DesktopWebBinary;
        const bytes = Buffer.from(binary.bodyBase64, 'base64');
        if (bytes.length > 32 * 1024) {
          const parts = Math.ceil(bytes.length / (512 * 1024));
          for (let index = 0; index < parts; index++) {
            await this.#remote('binary-put', { id: command.id, index, data: bytes.subarray(index * 512 * 1024, (index + 1) * 512 * 1024).toString('base64') });
          }
          result = { binaryParts: parts, size: bytes.length, contentType: binary.contentType, status: binary.status };
        }
      }
      if (Buffer.byteLength(JSON.stringify(result ?? null)) > 48 * 1024) {
        const bytes = Buffer.from(JSON.stringify(result));
        const parts = Math.ceil(bytes.length / (512 * 1024));
        for (let index = 0; index < parts; index++) {
          await this.#remote('binary-put', { id: command.id, index, data: bytes.subarray(index * 512 * 1024, (index + 1) * 512 * 1024).toString('base64') });
        }
        result = { jsonParts: parts, size: bytes.length };
      }
      answer = { id: command.id, result: result ?? null };
    } catch (error) { answer = { id: command.id, error: message(error) }; }
    // Retry only delivery of the saved answer. Never repeat a project mutation.
    while (!this.#controller.signal.aborted) {
      try { await this.#remote('complete', answer); return; }
      catch (error) { this.#options.diagnostic?.(message(error)); await pause(2000, this.#controller.signal); }
    }
  }
}
/** Keep the durable state request below the existing function gateway's 64 KiB limit. */
export function desktopEventBatch(events: Array<{ channel: string; payload: unknown }>): Array<{ channel: string; payload: unknown }> {
  const batch: Array<{ channel: string; payload: unknown }> = [];
  let bytes = 256;
  for (const event of events.slice(0, 100)) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (batch.length && bytes + size > 48 * 1024) break;
    batch.push(event);
    bytes += size;
  }
  return batch;
}
export function previewCapability(projectId: string, token: string): string { return createHmac('sha256', token).update(`preview:${projectId}`).digest('base64url'); }
export function makeDesktopToken(): string { return randomBytes(32).toString('base64url'); }
function session(token: string): string { return createHmac('sha256', token).update('desktop-owner-session').digest('base64url'); }
function equal(a: unknown, b: string): boolean { return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function contained(root: string, path: string): boolean { const rel = relative(root, path); return !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep); }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function json(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value)); }
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) { total += chunk.length; if (total > 29 * 1024 * 1024) throw new Error('上传内容过大'); chunks.push(Buffer.from(chunk)); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求内容无效');
  return value;
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((done) => { const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); }; const timer = setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true }); });
}
