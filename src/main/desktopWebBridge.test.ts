import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopWebBridge, desktopEventBatch, makeDesktopToken } from './desktopWebBridge.js';

const fixtures: Array<{ bridge: DesktopWebBridge; root: string }> = [];
const projectId = '11111111-1111-4111-8111-111111111111';

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ bridge, root }) => {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ludoready-desktop-web-'));
  const rendererRoot = join(root, 'renderer');
  const uploadRoot = join(root, 'uploads');
  await mkdir(rendererRoot);
  await writeFile(join(rendererRoot, 'index.html'), '<!doctype html><title>LudoReady</title>');
  const invoke = vi.fn(async (_channel: string, _args: unknown[]) => ({ ok: true }));
  const preview = vi.fn(async (_id: string, _path: string) => ({
    bodyBase64: Buffer.from('<!doctype html><canvas></canvas>').toString('base64'),
    contentType: 'text/html; charset=utf-8',
  }));
  const download = vi.fn(async (_id: string) => ({
    bodyBase64: Buffer.from('archive').toString('base64'),
    contentType: 'application/zip',
  }));
  const token = makeDesktopToken();
  const bridge = new DesktopWebBridge({ rendererRoot, uploadRoot, token, port: 0, invoke, preview, download });
  fixtures.push({ bridge, root });
  await bridge.start();
  const post = (path: string, value: unknown, cookie?: string, origin = bridge.origin) => fetch(`${bridge.origin}${path}`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(value),
  });
  const pair = async () => {
    const response = await post('/desktop/connect', { token });
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  return { root, rendererRoot, uploadRoot, bridge, invoke, preview, download, token, post, pair };
}

describe('desktop Web bridge', () => {
  it('reduces idle cloud polls to every 10 seconds, wakes for new events, and keeps active work responsive', async () => {
    const f = await fixture();
    const realFetch = globalThis.fetch;
    const operations: string[] = [];
    const queued: Array<{ id: string; channel: string; args: unknown[] }> = [];
    const remoteOrigin = 'https://workbench.example';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) !== `${remoteOrigin}/desktop/worker`) return realFetch(input, init);
      const value = JSON.parse(String(init?.body)) as { op: string };
      operations.push(value.op);
      return Response.json(value.op === 'poll' ? { requests: queued.splice(0) } : { ok: true });
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flush = async () => { await new Promise<void>((done) => setImmediate(done)); };
    try {
      f.bridge.connectRemote(remoteOrigin);
      await flush();
      expect(operations).toEqual(['poll']);
      await vi.advanceTimersByTimeAsync(9999);
      expect(operations).toEqual(['poll']);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(operations).toEqual(['poll', 'poll']);

      f.bridge.publish('ludoready:event:agent', { message: '正在制作' });
      await flush();
      expect(operations).toEqual(['poll', 'poll', 'poll', 'events']);
      await vi.advanceTimersByTimeAsync(999);
      expect(operations.filter((op) => op === 'poll')).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(operations.filter((op) => op === 'poll')).toHaveLength(4);

      queued.push({ id: projectId, channel: 'ludoready:bootstrap', args: [] });
      await vi.advanceTimersByTimeAsync(9999);
      expect(f.invoke).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(f.invoke).toHaveBeenCalledOnce();
      expect(operations).toContain('complete');
      await vi.advanceTimersByTimeAsync(1000);
      expect(operations.filter((op) => op === 'poll')).toHaveLength(6);
    } finally {
      await f.bridge.stop();
      vi.useRealTimers();
      fetchMock.mockRestore();
    }
  });

  it('flushes Chinese production events within the real state gateway request limit without skipping records', () => {
    const events = Array.from({ length: 100 }, (_, index) => ({ channel: 'ludoready:event:agent', payload: { index, message: '游戏画面'.repeat(200) } }));
    const remaining = [...events];
    const delivered = [];
    while (remaining.length) {
      const batch = desktopEventBatch(remaining);
      expect(Buffer.byteLength(JSON.stringify({ op: 'desktop-events', workerId: projectId, events: batch }))).toBeLessThan(64 * 1024);
      delivered.push(...batch);
      remaining.splice(0, batch.length);
    }
    expect(delivered).toEqual(events);
  });
  it('requires owner pairing before desktop operations and sets a protected session cookie', async () => {
    const f = await fixture();
    const rpc = { channel: 'ludoready:bootstrap', args: [] };
    expect((await f.post('/desktop/rpc', rpc)).status).toBe(401);
    expect((await fetch(`${f.bridge.origin}/desktop/events`)).status).toBe(401);
    expect((await f.post('/desktop/connect', { token: 'wrong-owner-token' })).status).toBe(401);
    expect(f.invoke).not.toHaveBeenCalled();
    const connected = await f.post('/desktop/connect', { token: f.token });
    const setCookie = connected.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain(f.token);
    const cookie = setCookie.split(';')[0]!;
    expect(await (await f.post('/desktop/rpc', rpc, cookie)).json()).toEqual({ result: { ok: true } });
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.invoke).toHaveBeenCalledWith('ludoready:bootstrap', []);
  });

  it('rejects foreign or missing POST origins even with the correct owner credential', async () => {
    const f = await fixture();
    const cookie = await f.pair();
    const rpc = { channel: 'ludoready:project:create', args: [{ idea: 'Snake' }] };
    expect((await f.post('/desktop/rpc', rpc, cookie, 'https://unrelated.example')).status).toBe(403);
    expect((await f.post('/desktop/connect', { token: f.token }, undefined, 'https://unrelated.example')).status).toBe(403);
    const missing = await fetch(`${f.bridge.origin}/desktop/rpc`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(rpc),
    });
    expect(missing.status).toBe(403);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('replays events after the supplied cursor across a browser reconnect', async () => {
    const f = await fixture();
    const cookie = await f.pair();
    f.bridge.publish('ludoready:event:project', { id: projectId, status: 'running' });
    f.bridge.publish('ludoready:event:agent', { projectId, message: 'Planning' });
    const first = await (await fetch(`${f.bridge.origin}/desktop/events?after=0`, { headers: { Cookie: cookie } })).json();
    expect(first).toMatchObject({ connected: true, cursor: 2, events: [{ id: 1 }, { id: 2 }] });
    const replay = await (await fetch(`${f.bridge.origin}/desktop/events?after=1`, { headers: { Cookie: cookie } })).json();
    expect(replay.events).toEqual([{ id: 2, channel: 'ludoready:event:agent', payload: { projectId, message: 'Planning' } }]);
    f.bridge.publish('ludoready:event:project', { id: projectId, status: 'complete' });
    const resumed = await (await fetch(`${f.bridge.origin}/desktop/events?after=${first.cursor}`, { headers: { Cookie: cookie } })).json();
    expect(resumed).toEqual({ connected: true, cursor: 3, events: [{ id: 3, channel: 'ludoready:event:project', payload: { id: projectId, status: 'complete' } }] });
  });

  it('keeps duplicate attachment names distinct within its upload directory', async () => {
    const f = await fixture();
    const cookie = await f.pair();
    const files = ['first', 'second'].map((data) => ({ name: 'reference.txt', data: Buffer.from(data).toString('base64') }));
    const response = await f.post('/desktop/upload', { files }, cookie);
    expect(response.status).toBe(200);
    const { result: { paths } } = await response.json() as { result: { paths: string[] } };
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    expect(dirname(paths[0]!)).toBe(dirname(paths[1]!));
    for (const path of paths) expect(relative(f.uploadRoot, path)).not.toMatch(/^\.\./u);
    expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(['first', 'second']);
  });

  it('rejects attachment traversal, foreign path separators and unsupported formats', async () => {
    const f = await fixture();
    const cookie = await f.pair();
    for (const name of ['../outside.txt', '/tmp/outside.txt', 'folder/reference.txt', 'folder\\reference.txt', 'run.sh']) {
      const response = await f.post('/desktop/upload', { files: [{ name, data: Buffer.from('unsafe').toString('base64') }] }, cookie);
      expect(response.status, name).toBe(400);
    }
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('does not serve files through renderer symlinks pointing outside the renderer directory', async () => {
    const f = await fixture();
    const outside = join(f.root, 'outside.txt');
    await writeFile(outside, 'private host file');
    await symlink(outside, join(f.rendererRoot, 'leaked.txt'));
    await symlink(f.root, join(f.rendererRoot, 'outside-directory'));
    expect((await fetch(`${f.bridge.origin}/leaked.txt`)).status).toBe(404);
    expect((await fetch(`${f.bridge.origin}/outside-directory/outside.txt`)).status).toBe(404);
    expect(await (await fetch(`${f.bridge.origin}/`)).text()).toContain('<title>LudoReady</title>');
  });

  it('allows a valid game preview capability to read that game without granting RPC or download access', async () => {
    const f = await fixture();
    const capabilityPath = f.bridge.previewUrl(projectId);
    const game = await fetch(`${f.bridge.origin}${capabilityPath}?v=2`);
    expect(game.status).toBe(200);
    expect(await game.text()).toContain('<canvas>');
    expect(game.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-pointer-lock');
    expect(game.headers.get('content-security-policy')).toContain(`connect-src ${f.bridge.origin}${f.bridge.previewUrl(projectId)}`);
    expect(f.preview).toHaveBeenCalledWith(projectId, 'index.html?v=2');
    const anotherProject = capabilityPath.replace(projectId, '22222222-2222-4222-8222-222222222222');
    expect((await fetch(`${f.bridge.origin}${anotherProject}`)).status).toBe(403);
    expect((await f.post(`/desktop/rpc?preview=${capabilityPath}`, { channel: 'ludoready:bootstrap', args: [] })).status).toBe(401);
    expect((await fetch(`${f.bridge.origin}/desktop/download/${projectId}?preview=${capabilityPath}`)).status).toBe(401);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
  });
});
