import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getStore } from '@edgeone/pages-blob';
import { chromium } from 'playwright';
import { runWebPlaytest } from '../server/playtest.js';

export interface RuntimeProbeContext {
  /** @edgeone/types 1.0.2 AgentContextRequest is a normalized plain object. */
  request: { method: string; body: unknown };
  sandbox: {
    commands: { run(command: string, options?: { timeout?: number }): Promise<{ exitCode: number }> };
    browser: { cdpUrl: string };
  };
}

export interface RuntimeProbeConfig {
  guardHash: string;
  files: Array<{ path: string; base64: string }>;
}

/** Runs a known published game, never a model request or an arbitrary command. */
export async function runtimeProbe(context: RuntimeProbeContext, config: RuntimeProbeConfig): Promise<Response> {
  if (context.request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const body = context.request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return response({ error: 'Invalid request body' }, 400);
  const guard = (body as { guard?: unknown }).guard;
  const supplied = createHash('sha256').update(typeof guard === 'string' ? guard : '').digest();
  const expected = Buffer.from(config.guardHash, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return response({ error: 'Forbidden' }, 403);
  const { mode, run } = body as { mode?: unknown; run?: unknown };
  if (mode === 'lifecycle-start' || mode === 'lifecycle-status') {
    if (typeof run !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(run)) return response({ error: 'Invalid probe run' }, 400);
    return lifecycleProbe(mode, run);
  }

  const checks: Array<{ id: string; status: 'pass' | 'repair'; message: string }> = [];
  let stage = 'filesystem';
  let root: string | undefined;
  let blobKey: string | undefined;
  let blob: ReturnType<typeof getStore> | undefined;
  let cdpAccessToken: string | undefined;
  let cdp: { protocol: string; queryParameterNames: string[] } | undefined;
  const redact = (message: string) => sanitize(message, [typeof guard === 'string' ? guard : '', cdpAccessToken ?? '']);
  try {
    root = await mkdtemp(join(tmpdir(), 'ludoready-edgeone-probe-'));
    await mkdir(join(root, 'filesystem'), { recursive: true });
    await writeFile(join(root, 'filesystem/ready.txt'), 'ready');
    if (await readFile(join(root, 'filesystem/ready.txt'), 'utf8') !== 'ready') throw new Error('Filesystem read/write failed');
    checks.push({ id: stage, status: 'pass', message: 'Node temporary filesystem supports directory creation and file read/write.' });

    stage = 'http';
    await checkLoopbackHttp();
    checks.push({ id: stage, status: 'pass', message: 'Node HTTP server and host-side loopback fetch passed.' });

    stage = 'blob';
    blob = getStore('ludoready-runtime-probe');
    blobKey = `probe/${randomUUID()}.json`;
    const nonce = randomUUID();
    await blob.setJSON(blobKey, { nonce });
    const value = await blob.get(blobKey, { type: 'json', consistency: 'strong' }) as { nonce?: string } | null;
    if (value?.nonce !== nonce) throw new Error('Blob strong read did not match the write');
    await blob.delete(blobKey);
    if (await blob.get(blobKey, { type: 'json', consistency: 'strong' }) !== null) throw new Error('Blob probe key was not deleted');
    blobKey = undefined;
    checks.push({ id: stage, status: 'pass', message: 'Blob JSON write, strongly consistent read and deletion passed.' });

    stage = 'sandbox';
    const initialization = await context.sandbox.commands.run('true', { timeout: 30 });
    if (initialization.exitCode !== 0) throw new Error('Sandbox initialization command failed');
    const cdpUrl = context.sandbox.browser.cdpUrl;
    if (typeof cdpUrl !== 'string' || !cdpUrl) throw new Error('Sandbox CDP is unavailable');
    const cdpEndpoint = new URL(cdpUrl);
    cdpAccessToken = cdpEndpoint.searchParams.get('access_token') ?? undefined;
    cdp = { protocol: cdpEndpoint.protocol, queryParameterNames: [...new Set(cdpEndpoint.searchParams.keys())] };
    checks.push({ id: stage, status: 'pass', message: 'Sandbox command and managed browser CDP are available.' });

    stage = 'browser-connect';
    // Official pages_agent_toolkit browser.py passes the getter token in this header.
    const browser = await chromium.connectOverCDP(cdpUrl, {
      timeout: 30000,
      ...(cdpAccessToken ? { headers: { 'X-Access-Token': cdpAccessToken } } : {}),
    });
    try {
      checks.push({ id: stage, status: 'pass', message: 'Direct Playwright CDP connection passed.' });
      stage = 'browser-context';
      const browserContext = await browser.newContext({ viewport: { width: 640, height: 360 }, acceptDownloads: false });
      try {
        const page = await browserContext.newPage();
        checks.push({ id: stage, status: 'pass', message: 'Managed Chromium created an isolated context and page.' });
        stage = 'browser-navigation';
        await page.goto('data:text/html,<title>LudoReady</title><h1>Browser connectivity</h1>', { waitUntil: 'load', timeout: 15000 });
        checks.push({ id: stage, status: 'pass', message: 'Managed Chromium loaded the probe data page.' });
        stage = 'browser-screenshot';
        const screenshot = await page.screenshot({ type: 'png', timeout: 15000 });
        if (screenshot.length === 0) throw new Error('Managed Chromium returned an empty screenshot');
        checks.push({ id: stage, status: 'pass', message: 'Managed Chromium produced a PNG screenshot.' });
      } finally {
        await browserContext.close().catch(() => undefined);
      }
    } finally {
      await browser.close().catch(() => undefined);
    }

    stage = 'playtest';
    for (const file of config.files) {
      if ((!file.path.startsWith('public/') && file.path !== '.ludoready/playtest.json')
        || file.path.includes('\0') || file.path.split('/').includes('..')) throw new Error('Invalid bundled fixture');
      const target = join(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.base64, 'base64'));
    }
    const report = await runWebPlaytest(root, { cdpUrl });
    checks.push({ id: stage, status: report.verdict, message: 'Completed the existing production player journey using managed Chromium.' });
    return response({
      ok: report.verdict === 'pass', nodeVersion: process.version,
      checks, cdp,
      playtest: {
        verdict: report.verdict, score: report.score, durationMs: report.durationMs, timedOut: report.timedOut,
        checks: report.checks.map((check) => ({ id: check.id, label: check.label, status: check.status, message: redact(check.message) })),
        errors: report.errors.map((error) => ({ message: redact(error.message) })),
        droppedErrors: report.droppedErrors,
      },
    });
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : 'Runtime probe failed');
    const cause = error instanceof Error && error.cause instanceof Error ? redact(error.cause.message) : undefined;
    checks.push({ id: stage, status: 'repair', message: cause ? `${message} Cause: ${cause}` : message });
    return response({ ok: false, nodeVersion: process.version, checks, cdp }, 500);
  } finally {
    if (blobKey && blob) await blob.delete(blobKey).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function lifecycleProbe(mode: 'lifecycle-start' | 'lifecycle-status', run: string): Promise<Response> {
  const blob = getStore('ludoready-runtime-probe');
  const key = `lifecycle/${run}.json`;
  if (mode === 'lifecycle-status') {
    const value = await blob.get(key, { type: 'json', consistency: 'strong' }) as { completed?: boolean } | null;
    return response({ completed: value?.completed === true });
  }
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: started\ndata: {"started":true}\n\n'));
      void (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10000));
        await blob.setJSON(key, { completed: true });
        if (!cancelled) {
          controller.enqueue(encoder.encode('event: completed\ndata: {"completed":true}\n\n'));
          controller.close();
        }
      })().catch(() => {
        if (!cancelled) controller.error(new Error('Lifecycle probe failed'));
      });
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
}

async function checkLoopbackHttp(): Promise<void> {
  const server = createServer((_request, reply) => { reply.writeHead(200, { 'Content-Type': 'text/plain' }); reply.end('ready'); });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Node HTTP listening failed');
    const result = await fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(10000) });
    if (await result.text() !== 'ready') throw new Error('Node HTTP loopback response failed');
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function sanitize(message: string, secrets: string[] = []): string {
  for (const secret of secrets) if (secret) message = message.split(secret).join('[secret]');
  return message.replace(/(?:https?|wss?|file):\/\/[^\s"'<>]+/giu, '[address]')
    .replace(/(?:[A-Za-z]:)?\/(?:[^\s"'<>]+\/)*[^\s"'<>]*/gu, '[path]').slice(0, 500);
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
