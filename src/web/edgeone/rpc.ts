import { WebInputError, type Job } from '../server/state.js';

export interface Publication {
  files: Array<{ path: string; key: string; size: number; type: string }>;
  archiveKeys: Array<{ key: string; size: number }>;
  sourceKey: string;
}
export interface CloudJob extends Job { publication?: Publication }
export type RuntimeEnv = Record<string, string | undefined>;

/** Only the service calls this bridge; the browser never receives its secret. */
export async function stateCall<T>(env: RuntimeEnv, op: string, input: Record<string, unknown> = {}): Promise<T> {
  if (!env.LUDO_STATE_URL || !env.LUDO_STATE_SECRET) throw new WebInputError(503, '项目保存服务尚未配置。');
  const response = await fetch(env.LUDO_STATE_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LUDO_STATE_SECRET}` },
    body: JSON.stringify({ op, ...input }), signal: AbortSignal.timeout(25_000),
  });
  const value = await response.json() as T & { error?: string; code?: string; message?: string };
  if (!response.ok) {
    if (value.code === 'FUNCTIONS_INVOCATION_FAILED' && value.message?.includes('InsufficientBalance')) {
      throw new WebInputError(503, '腾讯云项目状态服务因账户余额不足暂停，请处理欠费后重试。');
    }
    if ([400, 404, 409, 429].includes(response.status) && value.error) throw new WebInputError(response.status, value.error);
    throw new WebInputError(503, '项目保存服务暂时不可用，请稍后重试。');
  }
  return value;
}

export function sessionCookie(id: string): string { return `ludoready_${id.replaceAll('-', '')}`; }
export function readSession(cookies: string | null | undefined, id: string): string | undefined {
  const name = sessionCookie(id);
  return cookies?.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function requireProvider(env: RuntimeEnv): void {
  if (!env.DASHSCOPE_API_KEY || !env.DASHSCOPE_BASE_URL) throw new WebInputError(503, '创作服务尚未配置，请联系网站管理员。');
}
export function requireOrigin(origin: string | null | undefined, env: RuntimeEnv): void {
  if (origin && origin !== env.WEB_PUBLIC_ORIGIN) throw new WebInputError(403, '请求来源无效。');
}
export function publicError(error: unknown): { status: number; error: string } {
  if (error instanceof WebInputError) return { status: error.status, error: error.message };
  return { status: 500, error: '服务暂时不可用，请稍后重试。' };
}
