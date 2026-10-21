import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { CloudFunctionContext } from '@edgeone/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopCloudHandler } from './handler.js';
import { createOwnerSession, OWNER_COOKIE, previewCapability, publicOriginProof, validOwnerSession } from './protocol.js';
import { middleware } from './middleware.js';

const blobMocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), setJSON: vi.fn() }));
vi.mock('@edgeone/pages-blob', () => ({ getStore: () => blobMocks }));
const secret = 'a-desktop-owner-secret-over-32-characters';
const origin = 'https://ludoready.example.com';
const projectId = '11111111-1111-4111-8111-111111111111';
const cookie = () => `${OWNER_COOKIE}=${createOwnerSession(secret)}`;
function request(path: string, options: RequestInit = {}, targetOrigin = origin) {
  return desktopCloudHandler({ request: new Request(`${targetOrigin}${path}`, options), env: {
    WEB_PUBLIC_ORIGIN: origin, LUDO_DESKTOP_SECRET: secret, LUDO_STATE_URL: 'https://state.example.com', LUDO_STATE_SECRET: 'state-only-server-secret',
  } } as unknown as CloudFunctionContext);
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); blobMocks.get.mockReset(); blobMocks.set.mockReset(); blobMocks.setJSON.mockReset(); });

describe('desktop owner relay', () => {
  it('requires owner authentication and same-origin mutation before touching the queue', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect((await request('/desktop/events')).status).toBe(401);
    expect((await request('/desktop/rpc', { method: 'POST', headers: { cookie: cookie(), origin: 'null' }, body: JSON.stringify({ channel: 'ludoready:bootstrap', args: [] }) })).status).toBe(403);
    expect((await request('/desktop/worker', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'poll', workerId: randomUUID() }) })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    const connected = await request('/desktop/connect', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: secret }) });
    expect(connected.status).toBe(200);
    const session = connected.headers.get('set-cookie')!;
    expect(session).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(session).not.toContain(secret);
    expect(validOwnerSession(session, secret)).toBe(true);
    expect(validOwnerSession(session, `${secret}-changed`)).toBe(false);
    expect(validOwnerSession(session, secret, Date.now() + 25 * 60 * 60 * 1000)).toBe(false);
  });

  it('allows only registered desktop channels and submits a bounded durable request', async () => {
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      const input = JSON.parse(String(options.body));
      expect(input).toMatchObject({ op: 'desktop-submit', kind: 'rpc', channel: 'ludoready:bootstrap', args: [] });
      expect(options.headers).toMatchObject({ Authorization: 'Bearer state-only-server-secret' });
      return Response.json({ requestId: input.id });
    }); vi.stubGlobal('fetch', fetch);
    const headers = { origin, cookie: cookie(), 'content-type': 'application/json' };
    expect((await request('/desktop/rpc', { method: 'POST', headers, body: JSON.stringify({ channel: 'arbitrary:exec', args: [] }) })).status).toBe(400);
    const reply = await request('/desktop/rpc', { method: 'POST', headers, body: JSON.stringify({ channel: 'ludoready:bootstrap', args: [] }) });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ requestId: expect.stringMatching(/^[a-f0-9-]{36}$/u) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serves project-bound preview capabilities with an opaque sandbox and rejects traversal', async () => {
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      const input = JSON.parse(String(options.body));
      if (input.op === 'desktop-submit') {
        expect(input.args).toEqual([projectId, 'index.html']);
        return Response.json({ requestId: input.id });
      }
      return Response.json({ pending: false, result: { bodyBase64: Buffer.from('<canvas>game</canvas>').toString('base64'), contentType: 'text/html; charset=utf-8' } });
    }); vi.stubGlobal('fetch', fetch);
    const access = previewCapability(projectId, secret);
    expect((await request(`/desktop/preview/${projectId}/${'a'.repeat(43)}/`)).status).toBe(401);
    expect((await request(`/desktop/preview/${projectId}/${access}/%2e%2e%2fprivate`)).status).toBe(404);
    const reply = await request(`/desktop/preview/${projectId}/${access}/`);
    expect(await reply.text()).toBe('<canvas>game</canvas>');
    expect(reply.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-pointer-lock;');
    expect(reply.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    expect(reply.headers.get('content-security-policy')).toContain("'wasm-unsafe-eval'");
    expect(reply.headers.get('content-security-policy')).toContain("worker-src 'self' blob:");
    expect(reply.headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(reply.headers.get('content-security-policy')).toContain(`connect-src ${origin}/desktop/preview/${projectId}/${access}/`);
  });

  it('gives a separate game origin storage/worker permissions while restricting owner actions to the workbench origin', async () => {
    const secondary = 'https://ludo.example.com';
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      const input = JSON.parse(String(options.body));
      if (input.op === 'desktop-submit') {
        expect(input.args).toEqual([projectId, 'index.html?level=2&v=7']);
        return Response.json({ requestId: input.id });
      }
      return Response.json({ pending: false, result: { bodyBase64: Buffer.from('<canvas>game</canvas>').toString('base64'), contentType: 'text/html' } });
    }); vi.stubGlobal('fetch', fetch);
    const access = previewCapability(projectId, secret);
    const signedHeaders = { 'x-desktop-public-origin': secondary, 'x-desktop-public-origin-proof': publicOriginProof(secondary, secret) };
    const reply = await request(`/desktop/preview/${projectId}/${access}/?level=2&v=7`, { headers: signedHeaders }, 'http://pages-scf-internal.example.com');
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-security-policy')).toContain('sandbox allow-same-origin allow-scripts allow-pointer-lock;');
    expect(reply.headers.get('content-security-policy')).toContain(`connect-src ${secondary}/desktop/preview/${projectId}/${access}/`);
    expect(reply.headers.get('content-security-policy')).not.toContain(`connect-src ${origin}`);
    expect(reply.headers.get('access-control-allow-origin')).toBe('*');
    const before = fetch.mock.calls.length;
    for (const attemptedOrigin of [secondary]) {
      const denied = await request('/desktop/connect', { method: 'POST', headers: { origin: attemptedOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ token: secret }) }, secondary);
      expect(denied.status).toBe(403);
      const rpc = await request('/desktop/rpc', { method: 'POST', headers: { origin: attemptedOrigin, cookie: cookie(), 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'ludoready:bootstrap', args: [] }) }, secondary);
      expect(rpc.status).toBe(403);
    }
    expect(fetch).toHaveBeenCalledTimes(before);
  });

  it('preserves the public origin with a signed edge header despite cloud URL rewriting and rejects forged sandbox selection', async () => {
    const secondary = 'https://ludo.example.com';
    const next = vi.fn(() => new Response(null));
    await middleware({ request: new Request(`${secondary}/desktop/preview/${projectId}/`), env: { LUDO_DESKTOP_SECRET: secret }, next });
    expect(next).toHaveBeenCalledWith({ headers: { 'x-desktop-public-origin': secondary, 'x-desktop-public-origin-proof': publicOriginProof(secondary, secret) } });
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      const input = JSON.parse(String(options.body));
      return input.op === 'desktop-submit' ? Response.json({ requestId: input.id }) : Response.json({ pending: false, result: { bodyBase64: Buffer.from('<canvas>game</canvas>').toString('base64'), contentType: 'text/html' } });
    }); vi.stubGlobal('fetch', fetch);
    const access = previewCapability(projectId, secret);
    const forged = await request(`/desktop/preview/${projectId}/${access}/`, { headers: { 'x-desktop-public-origin': secondary, 'x-desktop-public-origin-proof': 'invalid-proof' } }, 'http://pages-scf-internal.example.com');
    expect(forged.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    expect(forged.headers.get('content-security-policy')).toContain(`connect-src ${origin}/desktop/preview/`);
    const connected = await request('/desktop/connect', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: secret }) }, 'http://pages-scf-internal.example.com');
    expect(connected.status).toBe(200);
  });

  it('forwards the prefixed worker operation and splits binary downloads into authenticated chunks', async () => {
    const workerId = randomUUID(), requestId = randomUUID();
    const wire: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      const input = JSON.parse(String(options.body)); wire.push(input);
      if (input.op === 'desktop-poll') return Response.json({ requests: [], connected: true });
      if (input.op === 'desktop-heartbeat') return Response.json({ connected: true });
      if (input.op === 'desktop-submit') return Response.json({ requestId });
      return Response.json({ pending: false, result: { binaryParts: 2, size: 700_000, contentType: 'application/zip' } });
    }); vi.stubGlobal('fetch', fetch);
    const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
    expect((await request('/desktop/worker', { method: 'POST', headers, body: JSON.stringify({ op: 'poll', workerId }) })).status).toBe(200);
    expect(wire[0]).toEqual({ op: 'desktop-poll', workerId });
    const bytes = Buffer.from('zip-binary-chunk');
    expect((await request('/desktop/worker', { method: 'POST', headers, body: JSON.stringify({ op: 'binary-put', workerId, id: requestId, index: 0, data: bytes.toString('base64') }) })).status).toBe(200);
    expect(blobMocks.set).toHaveBeenCalledWith(`desktop-files/${requestId}/0`, Uint8Array.from(bytes).buffer);
    const owner = { cookie: cookie() };
    const download = await request(`/desktop/download/${projectId}`, { headers: owner });
    const manifest = await download.json();
    expect(manifest).toMatchObject({ filename: `ludoready-${projectId}.zip`, chunks: [{ url: expect.stringMatching(/\/desktop\/download-chunk\/[a-f0-9-]{36}\/0/u) }, { url: expect.stringMatching(/\/1$/u) }] });
    expect((await request(manifest.chunks[0].url)).status).toBe(401);
    blobMocks.get.mockResolvedValue(Uint8Array.from(bytes).buffer);
    const chunk = await request(manifest.chunks[0].url, { headers: owner });
    expect(Buffer.from(await chunk.arrayBuffer())).toEqual(bytes);
    expect(chunk.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('stages real attachment bytes outside the small state gateway and lets only the worker restore them', async () => {
    const files = [{ name: '背景.png', data: Buffer.alloc(400_000, 7).toString('base64') }, { name: '角色.png', data: Buffer.alloc(400_000, 9).toString('base64') }];
    const blobs = new Map<string, ArrayBuffer>();
    blobMocks.set.mockImplementation(async (key: string, bytes: ArrayBuffer) => { blobs.set(key, bytes); });
    blobMocks.get.mockImplementation(async (key: string) => blobs.get(key) ?? null);
    let descriptor: { uploadParts: string; count: number } | undefined;
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      expect(Buffer.byteLength(String(options.body))).toBeLessThan(64 * 1024);
      const input = JSON.parse(String(options.body));
      expect(input).toMatchObject({ op: 'desktop-submit', kind: 'upload' });
      descriptor = input.args[0];
      expect(descriptor).toEqual({ uploadParts: expect.stringMatching(/^[a-f0-9-]{36}$/u), count: 3 });
      expect(String(options.body)).not.toContain(files[0]!.data);
      return Response.json({ requestId: input.id });
    }); vi.stubGlobal('fetch', fetch);
    const reply = await request('/desktop/upload', { method: 'POST', headers: { origin, cookie: cookie(), 'content-type': 'application/json' }, body: JSON.stringify({ files }) });
    expect(reply.status).toBe(200);
    const restored: Buffer[] = [];
    for (let index = 0; index < descriptor!.count; index++) {
      const path = `/desktop/worker/upload/${descriptor!.uploadParts}/${index}`;
      expect((await request(path)).status).toBe(403);
      const chunk = await request(path, { headers: { authorization: `Bearer ${secret}` } });
      expect(chunk.status).toBe(200);
      restored.push(Buffer.from(await chunk.arrayBuffer()));
    }
    expect(JSON.parse(Buffer.concat(restored).toString('utf8'))).toEqual({ files });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reconstructs a large JSON RPC result from private binary chunks without placing it in the state request', async () => {
    const id = randomUUID(), result = { text: 'x'.repeat(190_000), title: '保存的游戏文件' };
    const bytes = Buffer.from(JSON.stringify(result));
    blobMocks.get.mockImplementation(async (key: string) => key === `desktop-files/${id}/0` ? Uint8Array.from(bytes).buffer : null);
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      expect(JSON.parse(String(options.body))).toEqual({ op: 'desktop-result', id });
      return Response.json({ pending: false, result: { jsonParts: 1, size: bytes.length } });
    }); vi.stubGlobal('fetch', fetch);
    const reply = await request(`/desktop/result/${id}`, { headers: { cookie: cookie() } });
    expect(await reply.json()).toEqual({ pending: false, result });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serves large preview manifests with project-bound chunks and reuses only that same file request', async () => {
    let requestId = randomUUID();
    const otherProject = randomUUID();
    const access = previewCapability(projectId, secret), otherAccess = previewCapability(otherProject, secret);
    const metadata = new Map<string, unknown>();
    blobMocks.setJSON.mockImplementation(async (key: string, value: unknown) => { metadata.set(key, value); });
    const chunk = Uint8Array.from(Buffer.alloc(512 * 1024, 7)).buffer;
    blobMocks.get.mockImplementation(async (key: string) => metadata.get(key) ?? (key === `desktop-files/${requestId}/0` ? chunk : null));
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      const input = JSON.parse(String(options.body));
      if (input.op === 'desktop-submit') { requestId = input.id; return Response.json({ requestId }); }
      return Response.json({ pending: false, result: { binaryParts: 9, size: 4_484_201, contentType: 'image/png', status: 200 } });
    }); vi.stubGlobal('fetch', fetch);
    const path = `/desktop/preview-manifest/${projectId}/${access}/background.png?v=2`;
    const reply = await request(path);
    const manifest = await reply.json();
    expect(manifest).toMatchObject({ projectId, contentType: 'image/png', status: 200, size: 4_484_201, chunks: expect.any(Array) });
    expect(manifest.chunks).toHaveLength(9);
    expect(manifest.chunks[0].url).toBe(`/desktop/preview-chunk/${projectId}/${access}/${requestId}/0`);
    expect((await request(manifest.chunks[0].url)).status).toBe(200);
    expect((await request(`/desktop/preview-chunk/${otherProject}/${otherAccess}/${requestId}/0`)).status).toBe(404);
    expect((await request(`/desktop/preview-chunk/${projectId}/${access}/${requestId}/9`)).status).toBe(404);
    expect((await request(path, { headers: { 'x-desktop-preview-request': requestId } })).status).toBe(200);
    expect(fetch.mock.calls.filter((call) => JSON.parse(String(call[1].body)).op === 'desktop-submit')).toHaveLength(1);
    expect((await request(path.replace('background.png', 'other.png'), { headers: { 'x-desktop-preview-request': requestId } })).status).toBe(404);
  });

  it('accepts desktop-sized attachments through owner-authorized upload chunks instead of shrinking the file limit', async () => {
    const id = randomUUID();
    const original = { files: [{ name: '大背景.png', data: Buffer.alloc(4 * 1024 * 1024 + 1, 8).toString('base64') }] };
    const bytes = Buffer.from(JSON.stringify(original));
    const count = Math.ceil(bytes.length / (512 * 1024));
    const blobs = new Map<string, ArrayBuffer>();
    blobMocks.set.mockImplementation(async (key: string, value: ArrayBuffer) => { blobs.set(key, value); });
    blobMocks.get.mockImplementation(async (key: string) => blobs.get(key) ?? null);
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      expect(Buffer.byteLength(String(options.body))).toBeLessThan(64 * 1024);
      const input = JSON.parse(String(options.body));
      expect(input.args).toEqual([{ uploadParts: id, count }]);
      return Response.json({ requestId: input.id });
    }); vi.stubGlobal('fetch', fetch);
    const headers = { origin, cookie: cookie(), 'content-type': 'application/json' };
    const first = { id, index: 0, count, dataBase64: bytes.subarray(0, 512 * 1024).toString('base64') };
    expect((await request('/desktop/upload-part', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(first) })).status).toBe(401);
    for (let index = 0; index < count; index++) {
      const part = { id, index, count, dataBase64: bytes.subarray(index * 512 * 1024, (index + 1) * 512 * 1024).toString('base64') };
      expect((await request('/desktop/upload-part', { method: 'POST', headers, body: JSON.stringify(part) })).status).toBe(200);
    }
    expect(fetch).not.toHaveBeenCalled();
    const submitted = await request('/desktop/upload', { method: 'POST', headers, body: JSON.stringify({ uploadParts: id, count }) });
    expect(submitted.status).toBe(200);
    const restored: Buffer[] = [];
    for (let index = 0; index < count; index++) {
      const chunk = await request(`/desktop/worker/upload/${id}/${index}`, { headers: { authorization: `Bearer ${secret}` } });
      restored.push(Buffer.from(await chunk.arrayBuffer()));
    }
    const received = Buffer.concat(restored);
    expect(createHash('sha256').update(received).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    const decoded = JSON.parse(received.toString('utf8'));
    expect(decoded.files[0].name).toBe(original.files[0]!.name);
    expect(decoded.files[0].data.length).toBe(original.files[0]!.data.length);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

const require = createRequire(import.meta.url);
describe.skipIf(!process.env.LUDO_TEST_PGLITE_MODULE)('desktop durable PostgreSQL transport', () => {
  it('claims each RPC once, rejects competing workers, persists results/events and refuses stale work', async () => {
    const { PGlite } = require(process.env.LUDO_TEST_PGLITE_MODULE!);
    const db = new PGlite();
    const workerId = randomUUID(), otherWorker = randomUUID(), id = randomUUID();
    const call = async (op: string, input: Record<string, unknown> = {}) => (await db.query(
      'SELECT public.ludoready_desktop_state($1,$2::jsonb) AS value', [op, JSON.stringify(input)],
    )).rows[0].value;
    try {
      await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
      await db.exec(await readFile(new URL('./state.sql', import.meta.url), 'utf8'));
      await db.exec('SET ROLE service_role;');
      await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: 'service_role' })]);
      const input = { id, kind: 'rpc', channel: 'ludoready:project:create', args: [{ name: '游戏' }] };
      expect((await call('desktop-submit', input)).status).toBe(409);
      expect((await call('desktop-heartbeat', { workerId })).status).toBe(200);
      expect((await call('desktop-submit', input)).status).toBe(200);
      expect((await call('desktop-poll', { workerId })).body.requests).toEqual([input]);
      expect((await call('desktop-poll', { workerId })).body.requests).toEqual([]);
      expect((await call('desktop-poll', { workerId: otherWorker })).status).toBe(409);
      expect((await call('desktop-result', { id })).body.pending).toBe(true);
      expect((await call('desktop-complete', { workerId, id, result: { name: '本机游戏' } })).status).toBe(200);
      expect((await call('desktop-result', { id })).body).toMatchObject({ pending: false, result: { name: '本机游戏' } });
      expect((await call('desktop-complete', { workerId, id, result: { name: '本机游戏' } })).body).toEqual({ ok: true });
      expect((await call('desktop-result', { id })).body).toMatchObject({ pending: false, result: { name: '本机游戏' } });
      expect((await call('desktop-complete', { workerId, id, result: { name: '重复完成' } })).status).toBe(200);
      expect((await call('desktop-result', { id })).body.result).toEqual({ name: '本机游戏' });
      expect((await call('desktop-events', { workerId, events: [{ channel: 'ludoready:event:project', payload: { id: projectId } }] })).status).toBe(200);
      const updates = (await call('desktop-read-events', { cursor: 0 })).body;
      expect(updates).toMatchObject({ connected: true, cursor: 1, events: [{ id: 1, channel: 'ludoready:event:project', payload: { id: projectId } }] });
      expect((await call('desktop-read-events', { latest: true })).body).toEqual({ connected: true, cursor: 1, events: [] });
      expect((await call('desktop-read-events', { cursor: 1 })).body.events).toEqual([]);
      const pendingId = randomUUID(), claimedId = randomUUID();
      await call('desktop-submit', { ...input, id: claimedId }); await call('desktop-poll', { workerId });
      await call('desktop-submit', { ...input, id: pendingId });
      await db.exec("UPDATE public.ludoready_desktop_worker SET seen_at = clock_timestamp() - interval '1 minute'; UPDATE public.ludoready_desktop_requests SET created_at = clock_timestamp() - interval '3 minutes' WHERE status = 'pending';");
      expect((await call('desktop-read-events', { cursor: 1 })).body.connected).toBe(false);
      expect((await call('desktop-poll', { workerId: otherWorker })).body.requests).toEqual([]);
      expect((await call('desktop-result', { id: claimedId })).body).toMatchObject({ pending: false, error: expect.stringContaining('未自动重试') });
      expect((await call('desktop-result', { id: pendingId })).body).toMatchObject({ pending: false, error: expect.stringContaining('等待时间过长') });
      await db.exec('RESET ROLE; SET ROLE anon;');
      await expect(db.query('SELECT public.ludoready_desktop_state($1,$2::jsonb)', ['desktop-read-events', '{}'])).rejects.toThrow('permission denied');
    } finally { await db.close(); }
  }, 30_000);
});
