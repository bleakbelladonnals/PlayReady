import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { CloudFunctionContext } from '@edgeone/types';
import { cloudHandler } from './handler.js';
import { sessionCookie } from './rpc.js';

const mocks = vi.hoisted(() => ({ getStore: vi.fn() }));
vi.mock('@edgeone/pages-blob', () => ({ getStore: mocks.getStore }));

it('restricts failed-project diagnostics to the creator and keeps the failed game private', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const token = 'p'.repeat(43);
  const job = { id, prompt: '森林接苹果', revision: 0, status: 'failed', stage: '制作中断', error: '试玩未通过', events: [], hasPublished: false, publishedRevision: null, publication: null, draftSourceKey: 'private/draft/source', previewToken: token };
  const history = [{ stage: '试玩检查', findings: ['开始按钮没有反馈'] }];
  const playtest = { score: 50, verdict: 'repair', checks: [{ label: '开始操作', status: 'repair' }] };
  const values = new Map<string, unknown>([
    ['private/draft/source', { revision: 0, files: [{ path: 'production-history.json', key: 'private/history' }, { path: 'artifacts/playtest/latest/report.json', key: 'private/report' }, { path: 'production-source.json', key: 'private/code' }] }],
    ['private/history', history], ['private/report', playtest], ['private/code', { html: '<canvas>private-source</canvas>' }],
  ]);
  const blob = { get: vi.fn(async (key: string) => values.get(key) ?? null) };
  mocks.getStore.mockReturnValue(blob);
  const server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe('Bearer local-state-secret');
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const input = JSON.parse(raw);
    expect(['authorized', 'preview']).toContain(input.op);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ job: input.op === 'authorized' && input.session === 'creator-session' ? job : null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local state endpoint unavailable');
  const request = (path: string, session?: string) => cloudHandler({
    request: new Request(`https://games.example.com${path}`, { headers: session ? { cookie: `${sessionCookie(id)}=${session}` } : {} }),
    env: { LUDO_STATE_URL: `http://127.0.0.1:${address.port}`, LUDO_STATE_SECRET: 'local-state-secret' },
  } as unknown as CloudFunctionContext);
  try {
    expect((await request(`/api/projects/${id}/diagnostics`)).status).toBe(404);
    expect((await request(`/api/projects/${id}/diagnostics`, 'other-browser')).status).toBe(404);
    expect(blob.get).not.toHaveBeenCalled();
    const diagnostics = await request(`/api/projects/${id}/diagnostics`, 'creator-session');
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.headers.get('cache-control')).toBe('no-store');
    expect(await diagnostics.json()).toEqual({ revision: 0, history, playtest, productionError: null });
    expect(blob.get.mock.calls.some(([key]) => key === 'private/code')).toBe(false);
    const state = await request(`/api/projects/${id}`, 'creator-session');
    expect(await state.json()).toMatchObject({ status: 'failed', hasPublished: false, previewUrl: null, downloadUrl: null });
    blob.get.mockClear();
    expect((await request(`/play/${id}/${token}/`)).status).toBe(404);
    expect(blob.get).not.toHaveBeenCalled();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function withWakeFixture(check: (fixture: {
  produce: (options?: { origin?: string; session?: string; revision?: number }) => Promise<Response>;
  stateCalls: Array<Record<string, unknown>>;
  wakes: Array<{ authorization?: string; input: unknown }>;
  job: { id: string; revision: number; status: string };
  rejectWake: () => void;
}) => Promise<void>) {
  const id = '11111111-1111-4111-8111-111111111111';
  const job = { id, revision: 2, status: 'queued' };
  const stateCalls: Array<Record<string, unknown>> = [];
  const wakes: Array<{ authorization?: string; input: unknown }> = [];
  let wakeStatus = 200;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const input = JSON.parse(raw);
    if (req.url === '/state') {
      expect(req.headers.authorization).toBe('Bearer local-state-secret');
      stateCalls.push(input);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job: input.op === 'authorized' && input.id === id && input.session === 'creator-session' ? job : null }));
    } else {
      expect(req.url).toBe('/wake');
      wakes.push({ authorization: req.headers.authorization, input });
      res.writeHead(wakeStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: wakeStatus === 200 }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local wake endpoint unavailable');
  const produce = (options: { origin?: string; session?: string; revision?: number } = {}) => cloudHandler({
    // Makers Cloud Functions expose parsed object bodies, not Request streams.
    request: {
      url: 'https://games.example.com/produce', method: 'POST',
      headers: new Headers({ origin: options.origin ?? 'https://games.example.com', cookie: `${sessionCookie(id)}=${options.session ?? 'creator-session'}` }),
      body: { id, revision: options.revision ?? 2 },
    },
    env: {
      WEB_PUBLIC_ORIGIN: 'https://games.example.com', LUDO_STATE_URL: `http://127.0.0.1:${address.port}/state`,
      LUDO_STATE_SECRET: 'local-state-secret', LUDO_WORKER_URL: `http://127.0.0.1:${address.port}/wake`, LUDO_WORKER_SECRET: 'local-worker-secret',
    },
  } as unknown as CloudFunctionContext);
  try { await check({ produce, stateCalls, wakes, job, rejectWake: () => { wakeStatus = 503; } }); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('private SCF production wake', () => {
  it('rejects a wrong origin, noncreator and stale revision before waking the worker', async () => {
    await withWakeFixture(async ({ produce, stateCalls, wakes }) => {
      expect((await produce({ origin: 'https://other.example.com' })).status).toBe(403);
      expect(stateCalls).toHaveLength(0);
      expect((await produce({ session: 'other-browser' })).status).toBe(404);
      expect(stateCalls.at(-1)).toMatchObject({ op: 'authorized', session: 'other-browser' });
      expect((await produce({ revision: 1 })).status).toBe(409);
      expect(stateCalls.at(-1)).toMatchObject({ op: 'authorized', session: 'creator-session' });
      expect(wakes).toHaveLength(0);
    });
  });

  it('sends one authenticated wake for a queued request, returns a finished short SSE and does not wake a running job', async () => {
    await withWakeFixture(async ({ produce, wakes, job }) => {
      const queued = await produce();
      expect(queued.status).toBe(200);
      expect(queued.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(await queued.text()).toBe('data: {"queued":true}\n\n');
      expect(wakes).toEqual([{ authorization: 'Bearer local-worker-secret', input: { op: 'wake' } }]);
      job.status = 'running';
      const running = await produce();
      expect(running.status).toBe(200);
      expect(await running.text()).toBe('data: {"queued":true}\n\n');
      expect(wakes).toHaveLength(1);
    });
  });

  it('returns 503 on a rejected wake while keeping the stored queued project unchanged', async () => {
    await withWakeFixture(async ({ produce, stateCalls, wakes, job, rejectWake }) => {
      rejectWake();
      const response = await produce();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: '制作服务暂时不可用，项目已保存。' });
      expect(wakes).toHaveLength(1);
      expect(stateCalls).toEqual([{ op: 'authorized', id: job.id, session: 'creator-session' }]);
      expect(job).toEqual({ id: '11111111-1111-4111-8111-111111111111', revision: 2, status: 'queued' });
    });
  });
});
