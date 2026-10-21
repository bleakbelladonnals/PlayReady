import { describe, expect, it, vi } from 'vitest';
import { PLAN_REQUIREMENTS_SCHEMA, reviewPlanRequirements } from './requirements.js';

describe('independent pre-art requirements review', () => {
  it('sends the exact coin/basket request and conflicting fruit plan in one text-only check', async () => {
    const request = JSON.stringify({ originalRequest: '做一个方向键移动篮子、接金币得分、漏接3次结束的像素游戏', requestedChange: null, history: [] });
    const plan = { summary: '限时收集苹果、橙子和香蕉', rules: '60秒结束', controls: '方向键移动篮子', durationSeconds: 60,
      subjects: [{ id: 'fruit', role: 'pickup', description: '苹果、橙子和香蕉' }] };
    const review = { verdict: 'repair', findings: ['原要求接金币、漏接3次结束，当前规划限时收水果，请改回金币及漏接3次结束。'] };
    const ask = vi.fn().mockResolvedValue(review);
    expect(await reviewPlanRequirements(request, plan, ask)).toEqual(review);
    expect(ask).toHaveBeenCalledTimes(1);
    const [system, text, schema] = ask.mock.calls[0]!;
    expect(text).toBe(`USER REQUEST DATA\n${request}\nPROPOSED PLAN\n${JSON.stringify(plan)}`);
    expect(system).toContain('漏接3次结束');
    expect(system).toContain('30秒 must not become60秒');
    expect(schema).toBe(PLAN_REQUIREMENTS_SCHEMA);
    expect(ask.mock.calls[0]).toHaveLength(3);
  });

  it('preserves ordered explicit changes without adding unspecified requirements', async () => {
    const request = JSON.stringify({ originalRequest: '接金币，30秒结束', history: [{ prompt: '改为60秒' }], requestedChange: '只把标题改成金币雨' });
    const ask = vi.fn().mockResolvedValue({ verdict: 'pass', findings: [] });
    await expect(reviewPlanRequirements(request, { title: '金币雨', durationSeconds: 60 }, ask))
      .resolves.toEqual({ verdict: 'pass', findings: [] });
    const [system, text] = ask.mock.calls[0]!;
    expect(text).toContain(request);
    expect(system).toContain('chronological order and then requestedChange');
    expect(system).toContain('A title-only change does not authorize changing gameplay');
    expect(system).toContain('Do not demand details the user never specified');
    expect(system).toContain('Extra clickable controls for the same keyboard actions are compatible');
  });

  it.each([
    { verdict: 'pass' },
    { verdict: true, findings: [] },
    { verdict: 'pass', findings: ['需要换画风'] },
    { verdict: 'repair', findings: [] },
    { verdict: 'repair', findings: [' '] },
  ])('rejects malformed or self-contradictory results without a second model call: %j', async result => {
    const ask = vi.fn().mockResolvedValue(result);
    await expect(reviewPlanRequirements('{"originalRequest":"接金币"}', {}, ask)).rejects.toThrow('需求核对结果格式无效');
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
