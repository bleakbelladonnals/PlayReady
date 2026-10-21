import { afterEach, expect, it, vi } from 'vitest';
import { stateCall } from './rpc.js';

afterEach(() => vi.restoreAllMocks());

it('explains when the Tencent state function is suspended for insufficient balance', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
    code: 'FUNCTIONS_INVOCATION_FAILED',
    message: 'Function is Unavailable, AvailableStatus = InsufficientBalance.',
  }, { status: 400 }));

  await expect(stateCall({ LUDO_STATE_URL: 'https://state.example.com', LUDO_STATE_SECRET: 'test-secret' },
    'desktop-read-events', { latest: true })).rejects.toMatchObject({
    status: 503,
    message: '腾讯云项目状态服务因账户余额不足暂停，请处理欠费后重试。',
  });
});
