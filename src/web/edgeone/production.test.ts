import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentContext } from '@edgeone/types';
import { productionHandler } from './production.js';
import { sessionCookie, type CloudJob } from './rpc.js';

const mocks = vi.hoisted(() => ({ generateGame: vi.fn(), getStore: vi.fn() }));
vi.mock('../server/generator.js', () => ({ generateGame: mocks.generateGame }));
vi.mock('@edgeone/pages-blob', () => ({ getStore: mocks.getStore }));
afterEach(() => { vi.clearAllMocks(); });

it('saves failed source, art and diagnostics privately and restores them for the next modification', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const session = 'creator-session';
  const publication = { files: [{ path: 'index.html', key: 'published/index', size: 20, type: 'text/html' }], archiveKeys: [{ key: 'published/archive', size: 50 }], sourceKey: 'published/source' };
  let job: CloudJob = {
    id, prompt: '森林接苹果', status: 'queued', stage: '准备制作', error: null, events: [], createdAt: new Date().toISOString(),
    sessionHash: 'private-hash', previewToken: 'private-preview', revision: 1, changePrompt: '修复开始按钮', revisions: [],
    hasPublished: true, publishedRevision: 0, publication,
  };
  const values = new Map<string, unknown>([['published/source', { files: [] }]]);
  const blob = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, bytes: ArrayBuffer) => { values.set(key, bytes); }),
    setJSON: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }),
  };
  mocks.getStore.mockReturnValue(blob);
  const calls: Array<Record<string, any>> = [];
  const server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe('Bearer local-state-secret');
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const input = JSON.parse(raw);
    calls.push(input);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (input.op === 'claim') {
      expect(input.session).toBe(session);
      expect(input.revision).toBe(job.revision);
      res.end(JSON.stringify({ claimed: true, job }));
    } else {
      expect(input.op).toBe('update');
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local state endpoint unavailable');
  const kill = vi.fn(async () => {});
  const context = () => ({
    conversation_id: id,
    env: { WEB_PUBLIC_ORIGIN: 'https://games.example.com', DASHSCOPE_API_KEY: 'local-model-key', DASHSCOPE_BASE_URL: 'https://unused.example.com/v1', LUDO_STATE_URL: `http://127.0.0.1:${address.port}`, LUDO_STATE_SECRET: 'local-state-secret' },
    request: { method: 'POST', headers: { origin: 'https://games.example.com', cookie: `${sessionCookie(id)}=${session}` }, body: { id, revision: job.revision } },
    sandbox: { commands: { run: vi.fn(async () => {}) }, browser: { cdpUrl: 'ws://unused.example.com' }, kill },
  }) as unknown as AgentContext;
  const art = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  const trace = [{ stage: '试玩检查', findings: ['开始按钮没有反馈'] }];
  const report = { score: 50, verdict: 'repair', checks: [{ label: '开始操作', status: 'repair' }] };
  const source = { html: '<canvas id="game"></canvas>', css: 'canvas{width:100%}', js: 'const game = 1;' };
  mocks.generateGame.mockImplementationOnce(async (_job, config) => {
    const work = join(config.dataDir, 'projects', id, '.production', 'work');
    await mkdir(join(work, 'public', 'assets'), { recursive: true });
    await mkdir(join(work, 'artifacts', 'playtest', 'latest'), { recursive: true });
    await writeFile(join(work, 'public', 'assets', 'fox.png'), art);
    await writeFile(join(work, 'production-assets.json'), JSON.stringify({ player: 'public/assets/fox.png' }));
    await writeFile(join(work, 'production-source.json'), JSON.stringify(source));
    await writeFile(join(work, 'production-history.json'), JSON.stringify(trace));
    await writeFile(join(work, 'artifacts', 'playtest', 'latest', 'report.json'), JSON.stringify(report));
    throw new Error('修复后仍未通过试玩');
  });
  try {
    const failed = await productionHandler(context());
    expect(await failed.text()).toContain('"failed":true');
    const failedUpdate = calls.find((call) => call.status === 'failed')!;
    expect(failedUpdate).toMatchObject({ op: 'update', revision: 1, error: '修复后仍未通过试玩' });
    expect(failedUpdate.draftSourceKey).toMatch(new RegExp(`^projects/${id}/1/.+/draft/source.json$`));
    expect(failedUpdate).not.toHaveProperty('publication');
    expect(calls.some((call) => call.status === 'complete')).toBe(false);
    expect(job.publication).toEqual(publication);
    const draft = values.get(failedUpdate.draftSourceKey) as { files: Array<{ path: string; key: string }> };
    const stored = (path: string) => values.get(draft.files.find((file) => file.path === path)!.key) as ArrayBuffer;
    expect(Buffer.from(stored('public/assets/fox.png'))).toEqual(art);
    expect(JSON.parse(Buffer.from(stored('production-history.json')).toString())).toEqual(trace);
    expect(JSON.parse(Buffer.from(stored('artifacts/playtest/latest/report.json')).toString())).toEqual(report);

    job = { ...job, revision: 2, draftSourceKey: failedUpdate.draftSourceKey, changePrompt: '保留现有素材，修复开始操作' };
    blob.get.mockClear();
    let restoredFiles: { art: Buffer; source: unknown; assets: unknown; history: unknown } | undefined;
    mocks.generateGame.mockImplementationOnce(async (_job, config) => {
      const restored = join(config.dataDir, 'projects', id);
      restoredFiles = {
        art: await readFile(join(restored, 'public', 'assets', 'fox.png')),
        source: JSON.parse(await readFile(join(restored, 'production-source.json'), 'utf8')),
        assets: JSON.parse(await readFile(join(restored, 'production-assets.json'), 'utf8')),
        history: JSON.parse(await readFile(join(restored, 'production-history.json'), 'utf8')),
      };
      throw new Error('试玩检查仍需修复');
    });
    await (await productionHandler(context())).text();
    expect(restoredFiles).toEqual({ art, source, assets: { player: 'public/assets/fox.png' }, history: trace });
    expect(mocks.generateGame).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(blob.get.mock.calls[0]?.[0]).toBe(failedUpdate.draftSourceKey);
    expect(blob.get.mock.calls.some(([key]) => key === publication.sourceKey)).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function withProductionContext(job: CloudJob, sandbox: unknown, inspect: (context: AgentContext, updates: Array<Record<string, any>>) => Promise<void>): Promise<void> {
  const updates: Array<Record<string, any>> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const input = JSON.parse(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (input.op === 'claim') res.end(JSON.stringify({ claimed: true, job }));
    else { updates.push(input); res.end(JSON.stringify({ ok: true })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local state endpoint unavailable');
  const context = {
    conversation_id: job.id,
    env: { WEB_PUBLIC_ORIGIN: 'https://games.example.com', DASHSCOPE_API_KEY: 'local-model-key', DASHSCOPE_BASE_URL: 'https://unused.example.com/v1', LUDO_STATE_URL: `http://127.0.0.1:${address.port}`, LUDO_STATE_SECRET: 'local-state-secret' },
    request: { method: 'POST', headers: { origin: 'https://games.example.com', cookie: `${sessionCookie(job.id)}=creator-session` }, body: { id: job.id, revision: job.revision ?? 0 } },
    sandbox,
  } as unknown as AgentContext;
  try { await inspect(context, updates); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const lifecycleJob = (): CloudJob => ({
  id: '22222222-2222-4222-8222-222222222222', prompt: '森林接苹果', status: 'queued', stage: '准备制作', error: null,
  events: [], createdAt: new Date().toISOString(), sessionHash: 'private-hash', previewToken: 'private-preview', revision: 0,
});

it('releases an initialized sandbox after successful publication', async () => {
  const job = lifecycleJob();
  mocks.getStore.mockReturnValue({ set: vi.fn(async () => {}), setJSON: vi.fn(async () => {}) });
  const run = vi.fn(async () => {});
  const kill = vi.fn(async () => {});
  mocks.generateGame.mockImplementationOnce(async (_job, config) => {
    const project = join(config.dataDir, 'projects', job.id);
    await mkdir(join(project, 'public'), { recursive: true });
    await mkdir(join(project, '.ludoready'), { recursive: true });
    await mkdir(join(project, 'artifacts'), { recursive: true });
    for (const file of ['public/index.html', 'public/style.css', 'public/game.js', 'production-source.json', 'production-assets.json', 'production-plan.json', 'production-history.json', 'GAME_DESIGN.md', '.ludoready/playtest.json']) {
      await writeFile(join(project, file), file.endsWith('.json') ? '{}' : 'saved game');
    }
  });
  await withProductionContext(job, { commands: { run }, browser: { cdpUrl: 'ws://unused.example.com' }, kill }, async (context, updates) => {
    expect(await (await productionHandler(context)).text()).toContain('"complete":true');
    expect(updates.find((update) => update.status === 'complete')).toHaveProperty('publication.sourceKey');
    expect(updates.some((update) => update.status === 'failed')).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

it('reports monthly sandbox quota exhaustion without accessing kill or replacing the previous draft', async () => {
  const job = { ...lifecycleJob(), draftSourceKey: 'existing/draft/source.json', hasPublished: true, publication: { files: [], archiveKeys: [], sourceKey: 'existing/published/source.json' } };
  const error = Object.assign(new Error('Monthly sandbox GB-s quota exceeded'), {
    name: 'SandboxNotAvailableError', code: 'SANDBOX_LIMIT_EXCEEDED', operation: 'acquire', businessCode: 'LimitExceeded',
  });
  const run = vi.fn(async () => { throw error; });
  const killAccess = vi.fn();
  const sandbox = { commands: { run }, get kill() { killAccess(); throw new Error('kill would reacquire the sandbox'); } };
  await withProductionContext(job, sandbox, async (context, updates) => {
    expect(await (await productionHandler(context)).text()).toContain('"failed":true');
    expect(updates.find((update) => update.status === 'failed')).toMatchObject({
      error: '云端试玩资源本周期额度不足，项目已保留。额度恢复后可继续修改。', draftSourceKey: job.draftSourceKey,
    });
    expect(updates.some((update) => update.status === 'complete')).toBe(false);
    expect(mocks.generateGame).not.toHaveBeenCalled();
    expect(mocks.getStore).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(killAccess).not.toHaveBeenCalled();
    expect(job.publication.sourceKey).toBe('existing/published/source.json');
  });
});
