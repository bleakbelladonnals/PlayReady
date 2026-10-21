import { timingSafeEqual } from 'node:crypto';
import { runWorker } from './worker.js';
import { probeBrowser, runtimeInfo } from './browser.js';

type ScfEvent = { Type?: string; TriggerName?: string; httpMethod?: string; headers?: Record<string, string>; body?: string; op?: string };

export async function main_handler(event: ScfEvent) {
  if (event.httpMethod) {
    const authorization = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
    const secret = process.env.LUDO_WORKER_SECRET;
    const supplied = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
    const expected = Buffer.from(secret ?? '');
    if (!secret || secret.length < 32 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return { statusCode: 403, body: JSON.stringify({ error: '请求未获授权。' }) };
    }
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  }
  const input = event.httpMethod ? JSON.parse(event.body ?? '{}') as { op?: string } : event;
  if (input.op === 'runtime') return runtimeInfo();
  if (input.op === 'probe') return probeBrowser();
  if (input.op && input.op !== 'wake') throw new Error('不支持此制作请求。');
  return runWorker(process.env);
}
