import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebServer } from './server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((task) => task())); });

async function waitForSavedCompletion(root: string, id: string, revision: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const saved = JSON.parse(await readFile(join(root, 'data', 'state.json'), 'utf8')) as {
      jobs: Array<{ id: string; revision: number; status: string }>;
    };
    if (saved.jobs.some((job) => job.id === id && job.revision === revision && job.status === 'complete')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Final production did not finish before cleanup');
}

describe('public Web project flow', () => {
  it('creates without an invite, gates project access, and serves a playable download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-web-'));
    const clientDir = join(root, 'client');
    await mkdir(clientDir);
    await writeFile(join(clientDir, 'index.html'), '<h1>PlayReady</h1>');
    let generators = 0;
    let resumeRevision!: () => void;
    const revisionGate = new Promise<void>((resolve) => { resumeRevision = resolve; });
    const { server } = await createWebServer({
      dataDir: join(root, 'data'), clientDir, publicOrigin: 'http://example.test',
      baseUrl: 'https://example.test/compatible-mode/v1', apiKey: 'test-only',
      generator: async (job, config, progress) => {
        generators++;
        if (generators === 2) {
          expect(job).toMatchObject({ prompt: '一只小狐狸收集蘑菇', changePrompt: '增加三条生命', revision: 1, hasPublished: true });
          await revisionGate;
        }
        if (generators === 3) throw new Error('试玩检查发现游戏问题');
        await progress('制作玩法', '正在制作');
        const publicDir = join(config.dataDir, 'projects', job.id, 'public');
        await mkdir(publicDir, { recursive: true });
        await writeFile(join(publicDir, 'index.html'), `<h1>Playable game ${job.revision ?? 0}</h1><script src="./game.js"></script>`);
        await writeFile(join(publicDir, 'game.js'), 'document.body.dataset.ready = "yes";');
        await writeFile(join(config.dataDir, 'projects', job.id, 'README.md'), 'Game source');
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const blockedAdmin = await fetch(`${base}/api/admin/invites`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1 }),
    });
    expect(blockedAdmin.status).toBe(404);
    const create = await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://example.test' },
      body: JSON.stringify({ prompt: '一只小狐狸收集蘑菇' }),
    });
    expect(create.status).toBe(201);
    const cookie = create.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/^ludoready_session=/u);
    const { id } = await create.json() as { id: string };
    const unauthorized = await fetch(`${base}/api/projects/${id}`);
    expect(unauthorized.status).toBe(404);
    let status: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetch(`${base}/api/projects/${id}`, { headers: { Cookie: cookie! } });
      status = await response.json() as Record<string, unknown>;
      if (status.status === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status.status).toBe('complete');
    expect(status.previewUrl).toMatch(/^\/play\//u);
    expect(generators).toBe(1);
    const preview = await fetch(`${base}${status.previewUrl as string}`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('Playable game');
    expect(preview.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    const script = await fetch(new URL('game.js', preview.url));
    expect(await script.text()).toContain('dataset.ready');
    const download = await fetch(`${base}${status.downloadUrl as string}`, { headers: { Cookie: cookie! } });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).subarray(0, 4).toString('hex')).toBe('504b0304');
    const revisionUrl = `${base}/api/projects/${id}/revise`;
    const revisionRequest = (prompt: string, origin = 'http://example.test', sessionCookie = cookie!) => fetch(revisionUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: sessionCookie }, body: JSON.stringify({ prompt }),
    });
    expect((await revisionRequest('修改', 'http://other.test')).status).toBe(403);
    expect((await revisionRequest('修改', 'http://example.test', '')).status).toBe(404);
    expect((await revisionRequest('')).status).toBe(400);
    expect((await revisionRequest('增加三条生命')).status).toBe(202);
    expect((await revisionRequest('同时修改')).status).toBe(409);
    const duringRevision = await (await fetch(`${base}/api/projects/${id}`, { headers: { Cookie: cookie! } })).json() as Record<string, unknown>;
    expect(duringRevision).toMatchObject({ hasPublished: true, revision: 1, publishedRevision: 0, prompt: '一只小狐狸收集蘑菇' });
    expect(await (await fetch(`${base}${duringRevision.previewUrl as string}`)).text()).toContain('Playable game 0');
    expect((await fetch(`${base}/api/projects/${id}/download`, { headers: { Cookie: cookie! } })).status).toBe(200);
    resumeRevision();
    for (let attempt = 0; attempt < 30; attempt++) {
      status = await (await fetch(`${base}/api/projects/${id}`, { headers: { Cookie: cookie! } })).json() as Record<string, unknown>;
      if (status.status === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status).toMatchObject({ status: 'complete', revision: 1, publishedRevision: 1 });
    expect(status.previewUrl).toContain('?v=1');
    expect(await (await fetch(`${base}${status.previewUrl as string}`)).text()).toContain('Playable game 1');
    expect((await revisionRequest('这次失败仍保留旧版本')).status).toBe(202);
    for (let attempt = 0; attempt < 30; attempt++) {
      status = await (await fetch(`${base}/api/projects/${id}`, { headers: { Cookie: cookie! } })).json() as Record<string, unknown>;
      if (status.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status).toMatchObject({ status: 'failed', revision: 2, publishedRevision: 1, hasPublished: true });
    expect(await (await fetch(`${base}${status.previewUrl as string}`)).text()).toContain('Playable game 1');
    expect((await fetch(`${base}${status.downloadUrl as string}`, { headers: { Cookie: cookie! } })).status).toBe(200);
    expect((status.revisions as Array<{ prompt: string; status: string }>).map((item) => item.status)).toEqual(['complete', 'failed']);
    expect((await revisionRequest('失败后继续修改')).status).toBe(202);
    const another = await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://example.test' },
      body: JSON.stringify({ prompt: '第二个游戏' }),
    });
    expect(another.status).toBe(201);
    const { id: anotherId } = await another.json() as { id: string };
    await waitForSavedCompletion(root, anotherId, 0);
    await waitForSavedCompletion(root, id, 3);
    expect((await readFile(join(root, 'data', 'state.json'), 'utf8'))).not.toContain(cookie!.split('=')[1]!);
  });

  it('keeps both projects authorized in one cookie store and accepts legacy root sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-web-cookies-'));
    const clientDir = join(root, 'client');
    await mkdir(clientDir);
    const { server, state } = await createWebServer({
      dataDir: join(root, 'data'), clientDir, publicOrigin: 'http://example.test',
      baseUrl: 'https://example.test/compatible-mode/v1', apiKey: 'test-only',
      generator: async (job, config) => {
        const publicDir = join(config.dataDir, 'projects', job.id, 'public');
        await mkdir(publicDir, { recursive: true });
        await writeFile(join(publicDir, 'index.html'), `<h1>${job.prompt}</h1>`);
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const legacy = await state.create('旧项目');
    await state.update(legacy.job.id, 'complete', '制作完成', '旧项目完成');
    // Browser cookies are stored by path and sent with the longest matching path first.
    const cookiesByPath = new Map<string, string>([['/', `ludoready_session=${legacy.session}`]]);
    const cookiesFor = (path: string) => [...cookiesByPath]
      .filter(([cookiePath]) => cookiePath === '/' || path === cookiePath || path.startsWith(`${cookiePath}/`))
      .sort(([left], [right]) => right.length - left.length).map(([, value]) => value).join('; ');
    const ids: string[] = [];
    for (const prompt of ['第一个游戏', '第二个游戏']) {
      const response = await fetch(`${base}/api/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://example.test', Cookie: cookiesFor('/api/projects') },
        body: JSON.stringify({ prompt }),
      });
      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };
      const setCookie = response.headers.get('set-cookie')!;
      const cookiePath = /(?:^|;\s*)Path=([^;]+)/u.exec(setCookie)?.[1];
      expect(cookiePath).toBe(`/api/projects/${id}`);
      cookiesByPath.set(cookiePath!, setCookie.split(';')[0]!);
      ids.push(id);
    }
    expect(cookiesByPath.size).toBe(3);
    for (const [index, id] of ids.entries()) {
      const path = `/api/projects/${id}`;
      let project: { status?: string; prompt?: string } = {};
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await fetch(`${base}${path}`, { headers: { Cookie: cookiesFor(path) } });
        expect(response.status).toBe(200);
        project = await response.json();
        if (project.status === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(project).toMatchObject({ status: 'complete', prompt: index === 0 ? '第一个游戏' : '第二个游戏' });
      expect((await fetch(`${base}${path}/download`, { headers: { Cookie: cookiesFor(`${path}/download`) } })).status).toBe(200);
    }
    const firstPath = `/api/projects/${ids[0]}`;
    const revision = await fetch(`${base}${firstPath}/revise`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://example.test', Cookie: cookiesFor(`${firstPath}/revise`) },
      body: JSON.stringify({ prompt: '继续修改第一个游戏' }),
    });
    expect(revision.status).toBe(202);
    const legacyPath = `/api/projects/${legacy.job.id}`;
    expect((await fetch(`${base}${legacyPath}`, { headers: { Cookie: cookiesFor(legacyPath) } })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/${ids[1]}`, { headers: { Cookie: cookiesByPath.get(firstPath)! } })).status).toBe(404);
    await waitForSavedCompletion(root, ids[0]!, 1);
  });
});
