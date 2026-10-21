import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import { generateGame, type GeneratorConfig } from './generator.js';
import type { Job } from './state.js';
import type { GameplayExperienceReport, GameplayPlaytestInput, GameplayPlaytestManifest } from '../../main/gameplayExperienceEvaluator.js';

const plan = {
  title: '森林金币', summary: '在森林收集金币，躲开石块', rules: '收集金币，三次失误结束', controls: '方向键和触屏移动', journey: '开始、移动、收集、暂停、结束、重开',
  durationSeconds: null as number | null,
  artDirection: '明亮自然的像素插画', palette: ['#eaf5db', '#45836b', '#d8a321'], orientation: 'landscape', background: '无角色无金币的森林空地',
  animationAssessment: '<animation_needs_assessment generation="generate" presentation="2d">玩家两个动作帧</animation_needs_assessment>',
  reuseArt: false, subjects: [{ id: 'player', role: 'player', description: '小狐狸', frames: 2 }, { id: 'coin', role: 'pickup', description: '金币', frames: 1 }],
};
function manifest() {
  const actions = Object.fromEntries(['start', 'move', 'primary', 'pause', 'restart'].map((name) => [name, { inputs: [{ type: 'key', code: 'Enter', holdMs: 600 }] }]));
  const steps = [['launch', 'wait'], ['start-game', 'start'], ['move-player', 'move'], ['collect', 'primary'], ['paused', 'pause'], ['resumed', 'pause'], ['restarted', 'restart']];
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), engine: 'web', entrypoint: { path: 'public/index.html', readyTimeoutMs: 2000 }, actions,
    journey: steps.map(([id, action], index) => ({ id, action, inputs: index ? [] : [{ type: 'wait', ms: 18000 }], capture: `${id}.png`, observe: index ? [{ kind: 'screen-change', description: '画面变化', baselineStepId: steps[index - 1][0] }] : [{ kind: 'canvas-not-blank', description: '画面可见' }] })),
    success: [{ kind: 'canvas-not-blank', description: '画面可见', value: null, baselineStepId: null }], limits: { maxRunMs: 60000, stepTimeoutMs: 20000 } };
}
function imageBytes() {
  const image = new PNG({ width: 32, height: 32 });
  image.data.fill(255);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (x % 16 > 3 && x % 16 < 12 && y % 16 > 3 && y % 16 < 12) {
    const offset = (y * 32 + x) * 4;
    image.data[offset] = 60 + (x >= 16 ? 90 : 0); image.data[offset + 1] = 100; image.data[offset + 2] = 180;
  }
  return PNG.sync.write(image);
}
function responses(options: { invalidFirst?: boolean; stringPlaytest?: boolean; failHost?: boolean; failHostOnce?: boolean; invalidFormats?: Array<'syntax' | 'structure' | null>; invalidReviewBoolean?: boolean; invalidReviews?: Array<'missing' | null>; diagnosticSecret?: string; plans?: Array<Partial<typeof plan>>; playtests?: GameplayPlaytestManifest[]; routes?: GameplayPlaytestManifest[]; buttons?: Array<'missing' | 'dynamic' | 'html-string' | undefined>; css?: string; requirementReviews?: Array<{ verdict: string; findings: string[] }> } = {}) {
  let codeCalls = 0;
  let imageCalls = 0;
  let reuseArt = false;
  let playtestCalls = 0;
  let planCalls = 0;
  let reviewCalls = 0;
  let routeCalls = 0;
  let requirementCalls = 0;
  const roles: string[] = [];
  const bytes = imageBytes();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/images/generations')) {
      imageCalls++;
      return Response.json({ data: [{ url: 'https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/art.png?Expires=1' }] });
    }
    if (url.includes('oss-cn-shenzhen')) return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
    const body = JSON.parse(String(init?.body));
    const role = body.response_format.json_schema.name.replace('ludoready_', '');
    roles.push(role);
    expect(body.model).toBe('qwen3.8-flash');
    expect(body.enable_thinking).toBe(false);
    if (role === 'playtest') expect(body.messages[0].content).toContain('experience_playtest_contract');
    else if (role !== 'requirements') expect(body.messages[0].content).toContain('visual_asset_coverage_contract');
    const user = body.messages[1].content[0].text as string;
    let result: unknown;
    if (role === 'planner') result = { ...plan, ...options.plans?.[planCalls++], reuseArt };
    else if (role === 'requirements') {
      expect(body.messages[1].content).toHaveLength(1);
      result = options.requirementReviews?.[requirementCalls++] ?? { verdict: 'pass', findings: [] };
    }
    else if (role === 'reviewer') {
      expect(body.messages[1].content.some((item: { type: string }) => item.type === 'image_url')).toBe(true);
      result = options.invalidReviews?.[reviewCalls++] === 'missing'
        ? { verdict: 'pass', summary: `缺少字段 ${options.diagnosticSecret ?? ''}`, findings: [] }
        : { verdict: 'pass', summary: '通过', findings: [], regenerateArt: options.invalidReviewBoolean ? 'false' : false };
    }
    else if (role === 'playtest') result = options.routes?.[routeCalls++] ?? manifest();
    else {
      codeCalls++;
      expect(body.messages[1].content.some((item: { type: string }) => item.type === 'image_url')).toBe(true);
      if (options.invalidFormats?.[codeCalls - 1]) {
        const content = options.invalidFormats[codeCalls - 1] === 'syntax' ? '{' : JSON.stringify({ title: '缺少游戏文件' });
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
      }
      const assets = JSON.parse(user.split('HOST REGISTERED ASSETS\n')[1].split('\nCURRENT IMPLEMENTATION')[0]) as Array<{ paths: string[] }>;
      const playtest = options.playtests?.[codeCalls - 1] ?? manifest();
      const buttonKind = options.buttons?.[codeCalls - 1];
      const htmlButton = buttonKind ? '' : '<button type="button">开始游戏</button><button type="button">暂停</button><button type="button">继续游戏</button><button type="button">重新开始</button>';
      const dynamicButton = buttonKind === 'dynamic' ? "const button=document.createElement('button'); document.body.append(button);"
        : buttonKind === 'html-string' ? "const controls=document.createElement('div'); controls.innerHTML='<button type=button>开始游戏</button>'; document.body.append(controls);" : '';
      result = { title: `森林金币 ${codeCalls}`, html: `<!doctype html><html><head><title>游戏</title></head><body><main><img src="${assets[0]!.paths[0]}">${htmlButton}</main><script src="./game.js" defer></script></body></html>`, css: options.css ?? 'body{background:#eff5e9}', js: options.invalidFirst && codeCalls === 1 ? 'const x = ;' : `const files = ${JSON.stringify(assets.slice(1).flatMap((asset) => asset.paths).map((path) => basename(path)))}; files.forEach((file) => { const image = new Image(); image.src = './assets/images/' + file; document.body.append(image); }); ${dynamicButton}`, playtest: options.stringPlaytest ? JSON.stringify(playtest) : playtest };
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(role === 'implementer' || role === 'repair' ? [result] : result) } }] });
  });
  const playtest = vi.fn(async (root: string) => {
    const failHost = options.failHost || (options.failHostOnce && playtestCalls++ === 0);
    const directory = join(root, 'artifacts/playtest/latest/screenshots');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'before.png'), bytes);
    const report = {
      version: 1, verdict: failHost ? 'repair' : 'pass', score: failHost ? 0 : 100, checkedAt: new Date().toISOString(), durationMs: 1,
      reportPath: 'artifacts/playtest/latest/report.json', checks: [{ id: 'input-response', label: '操作', status: failHost ? 'repair' : 'pass', message: failHost ? '没有实际操作反馈' : '通过' }],
      surface: null, actions: [], journey: [], observations: [], temporalSamples: [], screenshots: { before: 'artifacts/playtest/latest/screenshots/before.png', idle: null, after: null, action: [] }, errors: [], droppedErrors: 0, timedOut: false,
    } as GameplayExperienceReport;
    await writeFile(join(root, report.reportPath), JSON.stringify(report));
    return report;
  });
  return { fetchMock, playtest, roles, get imageCalls() { return imageCalls; }, setReuse() { reuseArt = true; } };
}

describe('shared-contract Qwen production workflow', () => {
  it('corrects named objects before artwork and implementation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-plan-objects-'));
    try {
      const mock = responses({ plans: [{ summary: '接水果' }, plan], requirementReviews: [
        { verdict: 'repair', findings: ['原要求接金币，当前规划接水果，请改回金币。'] },
        { verdict: 'pass', findings: [] },
      ] });
      await generateGame({ id: 'objects', prompt: '方向键接金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined);
      expect(mock.roles).toEqual(['planner', 'requirements', 'planner', 'requirements', 'implementer', 'reviewer']);
      expect(mock.imageCalls).toBe(2);
      const requests = mock.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions')).map(([, init]) => JSON.parse(String(init?.body)));
      expect(requests[2].messages[1].content[0].text).toContain('请改回金币');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects an exact live timer assertion without changing game files or duration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-live-countdown-'));
    try {
      const exact = manifest() as unknown as GameplayPlaytestManifest;
      exact.success = [{ kind: 'text-visible', description: '重开计时器', value: '时间：60' }];
      const mock = responses({ plans: [{ durationSeconds: 60 }], playtests: [exact] });
      await generateGame({ id: 'timer', prompt: '接金币，每局60秒' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined);
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'playtest', 'reviewer']);
      const history = JSON.parse(await readFile(join(root, 'projects/timer/production-history.json'), 'utf8'));
      expect(history.find((entry: {role: string}) => entry.role === 'playtest-route-repair').result.finding).toContain('倒计时会在截图前变化');
      expect(JSON.parse(await readFile(join(root, 'projects/timer/production-plan.json'), 'utf8')).durationSeconds).toBe(60);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retains source and art during an explicitly requested route repair while still running host and reviewer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-route-only-'));
    try {
      const mock = responses();
      const config = { dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest };
      const job = { id: 'route-only', prompt: '接金币' } as Job;
      await generateGame(job, config, async () => undefined);
      const project = join(root, 'projects/route-only');
      const before = await Promise.all(['index.html', 'style.css', 'game.js'].map(file => readFile(join(project, 'public', file), 'utf8')));
      mock.roles.length = 0;
      await generateGame({ ...job, changePrompt: '仅修复试玩路线，保留代码和素材' }, config, async () => undefined);
      expect(mock.roles).toEqual(['playtest', 'reviewer']);
      expect(mock.imageCalls).toBe(2);
      expect(mock.playtest).toHaveBeenCalledTimes(2);
      expect(await Promise.all(['index.html', 'style.css', 'game.js'].map(file => readFile(join(project, 'public', file), 'utf8')))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects missing DOM controls while accepting buttons created dynamically or with HTML strings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-dom-controls-'));
    try {
      for (const [id, buttons] of [
        ['missing', ['missing', undefined]], ['dynamic', ['dynamic']], ['html-string', ['html-string']],
      ] as const) {
        const mock = responses({ buttons: [...buttons] });
        await generateGame({ id, prompt: '接金币' } as Job, {
          dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only',
          fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
        }, async () => undefined);
        expect(mock.playtest).toHaveBeenCalledTimes(1);
        expect(mock.imageCalls).toBe(2);
        if (id === 'missing') {
          expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'repair', 'reviewer']);
          const history = JSON.parse(await readFile(join(root, 'projects', id, 'production-history.json'), 'utf8'));
          expect(history.find((entry: { role: string }) => entry.role === 'preflight-error').result.message).toContain('实际 DOM 按钮');
          expect(mock.roles).not.toContain('playtest');
        } else expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'reviewer']);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('carries actual cropped geometry and frozen gameplay evidence into repair and unpublished draft continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-cropped-draft-'));
    try {
      const mock = responses();
      const normalPlaytest = mock.playtest.getMockImplementation()!;
      let cropped = true;
      mock.playtest.mockImplementation(async work => {
        const report = await normalPlaytest(work);
        if (cropped) {
          report.verdict = 'repair';
          report.surface = { found: true, selector: '#gameCanvas', tagName: 'canvas',
            bounds: { x: 212, y: -130, width: 600, height: 900 }, viewport: { width: 1024, height: 640 },
            visibleCanvasCount: 1, visibleCandidateCount: 1 };
          report.temporalSamples = ['resume', 'primary'].map(action => ({
            action: action as 'resume' | 'primary', stepId: `${action}-game`,
            screenshotPath: 'artifacts/playtest/latest/screenshots/before.png',
            changedPixelRatio: 0, meanChannelDelta: 0, sampledPixels: 100,
          }));
          await writeFile(join(work, report.reportPath!), JSON.stringify(report));
        }
        return report;
      });
      const job = { id: 'cropped-draft', prompt: '方向键移动接金币' } as Job;
      const config = { dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only',
        fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest };
      await expect(generateGame(job, config, async () => undefined)).rejects.toThrow('3 轮修复');
      cropped = false;
      mock.setReuse();
      await generateGame({ ...job, revision: 1, changePrompt: '修复上次制作中断，保留玩法和已有素材' }, config, async () => undefined);
      const requests = mock.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))
        .map(([, init]) => JSON.parse(String(init?.body)));
      const repair = requests.find(request => request.response_format.json_schema.name === 'ludoready_repair');
      const resumed = requests.filter(request => request.response_format.json_schema.name === 'ludoready_implementer').at(-1);
      for (const request of [repair, resumed]) {
        const text = request.messages[1].content[0].text;
        expect(text).toContain('x=212px、y=-130px、width=600px、height=900px');
        expect(text).toContain('窗口 width=1024px、height=640px');
        expect(text).toContain('保持原游戏逻辑坐标');
        expect(text).toContain('高度 × 场景宽高比');
        expect(text).toContain('resume-game 的像素变化为 0');
        expect(text).toContain('primary-game 的像素变化为 0');
        expect(text).toContain('不能用切换暂停的 Space');
        expect(request.messages[0].content).toContain('clickable start, pause, resume and restart buttons');
      }
      expect(resumed.messages[1].content.some((item: { text?: string }) => item.text === 'Host image: artifacts/playtest/latest/screenshots/before.png')).toBe(true);
      expect(mock.imageCalls).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('repairs an invalid text-hidden baseline against the same source without rewriting code or regenerating art', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-route-only-'));
    try {
      const bad = manifest() as unknown as GameplayPlaytestManifest;
      bad.journey = bad.journey.map(step => step.id === 'resumed' ? { ...step, observe: [{ kind: 'text-hidden', description: '恢复隐藏暂停', value: '已暂停', baselineStepId: 'collect' }] } : step);
      const mock = responses({ playtests: [bad] });
      await generateGame({ id: 'route-only', prompt: '森林金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined);
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'playtest', 'reviewer']);
      expect(mock.imageCalls).toBe(2);
      expect(mock.playtest).toHaveBeenCalledTimes(1);
      const source = JSON.parse(await readFile(join(root, 'projects/route-only/production-source.json'), 'utf8'));
      expect(source.title).toBe('森林金币 1');
      const requests = mock.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions')).map(([,init]) => JSON.parse(String(init?.body)));
      const routeRequest = requests.find(request => request.response_format.json_schema.name === 'ludoready_playtest');
      expect(routeRequest.messages[1].content).toHaveLength(1);
      expect(routeRequest.messages[1].content[0].text).toContain('ACTUAL GAME SOURCE');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps validated game files when route inputs fail the response schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-route-schema-'));
    try {
      const bad = manifest() as unknown as GameplayPlaytestManifest;
      delete (bad as Partial<GameplayPlaytestManifest>).updatedAt;
      bad.journey[6]!.inputs = [{ type: 'key', ms: 60 } as unknown as GameplayPlaytestInput];
      const mock = responses({ playtests: [bad] });
      await generateGame({ id: 'route-schema', prompt: '森林金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined);
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'playtest', 'reviewer']);
      const source = JSON.parse(await readFile(join(root, 'projects/route-schema/production-source.json'), 'utf8'));
      expect(source.title).toBe('森林金币 1');
      expect(mock.imageCalls).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('repairs a visibility assertion that contradicts the actual hidden CSS before browser playtest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-hidden-selector-'));
    try {
      const bad = manifest() as unknown as GameplayPlaytestManifest;
      bad.success = [{ kind: 'element-visible', description: '结束画面隐藏', value: '#end-screen.hidden' }];
      const mock = responses({ playtests: [bad], css: '.overlay.hidden{display:none}' });
      await generateGame({ id: 'hidden-selector', prompt: '森林金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined);
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'playtest', 'reviewer']);
      expect(mock.playtest).toHaveBeenCalledTimes(1);
      const history = JSON.parse(await readFile(join(root, 'projects/hidden-selector/production-history.json'), 'utf8'));
      expect(history.find((entry: { role: string }) => entry.role === 'playtest-route-repair').result.finding).toContain('display:none');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reserves host screenshot time without changing valid declared inputs or game duration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-host-time-'));
    try {
      const route = manifest() as unknown as GameplayPlaytestManifest;
      delete (route as Partial<GameplayPlaytestManifest>).updatedAt;
      route.limits.maxRunMs = 30000;
      const mock = responses({ playtests: [route] });
      await generateGame({ id: 'host-time', prompt: '森林金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined);
      const saved = JSON.parse(await readFile(join(root, 'projects/host-time/.ludoready/playtest.json'), 'utf8'));
      expect(saved.limits.maxRunMs).toBe(40600);
      expect(saved.limits.stepTimeoutMs).toBe(20500);
      expect(saved.journey[0].inputs.reduce((sum: number, input: { ms: number }) => sum + input.ms, 0)).toBe(18000);
      expect(saved.actions).toEqual(route.actions);
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'reviewer']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects total input time exceeding the whole run even when every step fits its own deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-total-budget-'));
    try {
      const excessive = manifest() as unknown as GameplayPlaytestManifest;
      excessive.limits.maxRunMs = 20000;
      const mock = responses({ playtests: [excessive] });
      await generateGame({ id: 'total-budget', prompt: '森林金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined);
      expect(mock.playtest).toHaveBeenCalledTimes(1);
      const history = JSON.parse(await readFile(join(root, 'projects/total-budget/production-history.json'), 'utf8'));
      expect(history.find((item: {role: string}) => item.role === 'playtest-route-repair').result.finding).toContain('总时限 20000ms');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not require removed subjects and allows an explicit endless revision to replace an old timed round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-revised-rules-'));
    try {
      const mock = responses({ plans: [{ durationSeconds: 30 }, { subjects: [plan.subjects[0]!], durationSeconds: null }] });
      const config = { dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest };
      const job = { id: 'revised-rules', prompt: '森林金币，每局限时30秒' } as Job;
      await generateGame(job, config, async () => undefined);
      mock.setReuse();
      await generateGame({ ...job, revision: 1, changePrompt: '删除金币道具，取消倒计时，改成无尽模式' }, config, async () => undefined);
      const assets = JSON.parse(await readFile(join(root, 'projects/revised-rules/production-assets.json'), 'utf8'));
      expect(assets.map((asset: {role: string}) => asset.role)).toEqual(['background', 'player']);
      expect(mock.imageCalls).toBe(2);
      const requests = mock.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions')).map(([,init]) => JSON.parse(String(init?.body)));
      expect(requests.filter(request => request.response_format.json_schema.name === 'ludoready_planner').at(-1).messages[0].content).toContain('HOST REQUIRED ROUND DURATION: unspecified');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('repairs an incomplete plan before paying for images and stops requests after the host deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-plan-deadline-'));
    try {
      const mock = responses({ plans: [{ controls: '', animationAssessment: '仅文字' }, plan] });
      const config = { dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest };
      await generateGame({ id: 'plan-complete', prompt: '森林金币' } as Job, config, async () => undefined);
      expect(mock.roles.slice(0,4)).toEqual(['planner', 'planner', 'requirements', 'implementer']);
      const expired = responses();
      await expect(generateGame({ id: 'expired', prompt: '森林金币' } as Job, { ...config, fetch: expired.fetchMock as typeof fetch, deadlineAt: Date.now() - 1 }, async () => undefined)).rejects.toThrow('运行时限');
      expect(expired.fetchMock).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('gives repair the actual failed journey and both start and resume screenshots instead of only summary findings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-failed-journey-'));
    try {
      const mock = responses();
      const normalPlaytest = mock.playtest.getMockImplementation()!;
      const observedFailure = { stepId: 'paused', kind: 'text-visible' as const, description: '暂停', status: 'repair' as const,
        message: '没有检测到已暂停，当前可见文字：游戏结束 最终得分：0' };
      mock.playtest.mockImplementationOnce(async (work) => {
        const report = await normalPlaytest(work);
        report.verdict = 'repair';
        report.observations = [observedFailure];
        report.journey = [
          { id: 'start', action: 'start' as const, durationMs: 1389 },
          { id: 'paused', action: 'pause' as const, durationMs: 3000 },
          { id: 'resumed', action: 'pause' as const, durationMs: 3126 },
        ].map(step => ({ ...step, screenshotPath: `artifacts/playtest/latest/screenshots/${step.id}.png`, observations: [] }));
        for (const step of report.journey) await writeFile(join(work, step.screenshotPath!), imageBytes());
        return report;
      });
      await generateGame({ id: 'failed-journey', prompt: '飞鸟' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined);
      const requests = mock.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))
        .map(([, init]) => JSON.parse(String(init?.body)));
      const repair = requests.find(request => request.response_format.json_schema.name === 'ludoready_repair');
      expect(repair.messages[1].content[0].text).toContain('PREVIOUS HOST PLAYTEST REPORT');
      expect(repair.messages[1].content[0].text).toContain('游戏结束 最终得分：0');
      expect(repair.messages[1].content[0].text).toContain('1389');
      expect(repair.messages[0].content).toContain('separate key presses and releases');
      expect(repair.messages[0].content).not.toContain('For move/primary hold keys >=400ms');
      const review = requests.find(request => request.response_format.json_schema.name === 'ludoready_reviewer');
      for (const request of [repair, review]) {
        const labels = request.messages[1].content.filter((item: { type: string }) => item.type === 'text').map((item: { text: string }) => item.text);
        for (const step of ['start', 'paused', 'resumed']) expect(labels).toContain(`Host image: artifacts/playtest/latest/screenshots/${step}.png`);
      }
      expect(mock.playtest).toHaveBeenCalledTimes(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects cumulative step input budgets before browser playtest and preserves long waits when split into real steps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-step-budget-'));
    try {
      const timedRoute = (inputs: GameplayPlaytestInput[]): GameplayPlaytestManifest => {
        const base = manifest() as unknown as GameplayPlaytestManifest;
        base.limits.stepTimeoutMs = 15000;
        base.journey = base.journey.map((step, index) => index ? step : { ...step, inputs: [] });
        const restart = base.journey.at(-1)!;
        base.journey = [...base.journey.slice(0, -1), {
          id: 'terminal', action: 'wait', inputs, capture: 'terminal.png',
          observe: [{ kind: 'text-visible', description: '正常倒计时结束', value: '游戏结束' }],
        }, { ...restart, observe: [{ kind: 'screen-change', description: '重开有反馈', baselineStepId: 'terminal' }] }];
        return base;
      };
      const waits = [10000, 10000, 10000, 4000].map((ms) => ({ type: 'wait' as const, ms }));
      const mixed: GameplayPlaytestInput[] = [
        { type: 'key', code: 'Enter', holdMs: 5000 },
        { type: 'look', deltaX: 10, deltaY: 0, durationMs: 2000 },
        { type: 'drag', fromXRatio: 0.2, fromYRatio: 0.2, toXRatio: 0.4, toYRatio: 0.4, button: 0, durationMs: 3000 },
        { type: 'wait', ms: 5000 },
      ];
      const fallback = timedRoute([]);
      fallback.actions.move.inputs = mixed;
      const split = timedRoute([]);
      const terminal = split.journey.find((step) => step.id === 'terminal')!;
      split.journey = split.journey.flatMap((step) => step.id !== 'terminal' ? [step] : waits.map((input, index) => ({
        ...terminal, id: index === 3 ? 'terminal' : `terminal-wait-${index + 1}`,
        inputs: [input], capture: `terminal-wait-${index + 1}.png`,
        observe: index === 3 ? terminal.observe : [{ kind: 'canvas-not-blank' as const, description: '等待时真实画面仍可见' }],
      })));
      const mock = responses({ playtests: [timedRoute(waits), timedRoute(mixed), fallback], routes: [timedRoute(mixed), fallback, split] });
      await generateGame({ id: 'step-budget', prompt: '森林金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined);
      expect(mock.playtest).toHaveBeenCalledTimes(1);
      const project = join(root, 'projects/step-budget');
      const history = JSON.parse(await readFile(join(project, 'production-history.json'), 'utf8'));
      const errors = history.filter((entry: { role: string }) => entry.role === 'playtest-route-repair')
        .map((entry: { result: { finding: string } }) => entry.result.finding);
      expect(errors).toHaveLength(3);
      expect(errors[0]).toContain('terminal 的输入累计时长 34000ms');
      expect(errors[0]).toContain('每步时限 15000ms');
      expect(errors[0]).toContain('拆分为多个步骤');
      expect(errors[1]).toContain('terminal 的输入累计时长 15000ms');
      expect(errors[2]).toContain('move-player 的输入累计时长 15000ms');
      const saved = JSON.parse(await readFile(join(project, '.ludoready/playtest.json'), 'utf8')) as GameplayPlaytestManifest;
      const savedWaits = saved.journey.filter((step) => step.id.startsWith('terminal'));
      expect(savedWaits.map((step) => step.inputs)).toEqual(waits.map((input) => [input]));
      expect(savedWaits.at(-1)!.observe).toEqual(terminal.observe);
      const repairs = mock.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))
        .map(([, init]) => JSON.parse(String(init?.body))).filter((request) => request.response_format.json_schema.name === 'ludoready_repair');
      expect(repairs[0].messages[1].content[0].text).toContain(errors[1]);
      expect(repairs[0].messages[0].content).toContain('cumulative waits, key holds, drags and looks');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps the provider rejection actionable while hiding the configured API key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-provider-error-'));
    try {
      const error = await generateGame({ id: 'provider-error', prompt: '小游戏' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'private-test-key',
        fetch: (async () => Response.json({ error: { code: 'InvalidParameter', message: 'Rejected private-test-key' } }, { status: 400 })) as typeof fetch,
      }, async () => undefined).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('HTTP 400');
      expect((error as Error).message).toContain('InvalidParameter');
      expect((error as Error).message).not.toContain('private-test-key');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('repairs bad code, reviews actual images and evidence, publishes only on host pass, then reuses art for a revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-production-'));
    try {
      const mock = responses({ invalidFirst: true, stringPlaytest: true });
      const config: GeneratorConfig = { dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest };
      const job = { id: '00000000-0000-4000-8000-000000000001', prompt: '森林接金币', revision: 0 } as Job;
      const stages: string[] = [];
      await generateGame(job, config, async (stage) => { stages.push(stage); });
      expect(stages).toContain('规划游戏'); expect(stages).toContain('试玩检查'); expect(stages).toContain('修复游戏');
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'repair', 'reviewer']);
      expect(mock.imageCalls).toBe(2);
      const project = join(root, 'projects', job.id);
      const html = await readFile(join(project, 'public/index.html'), 'utf8');
      expect(html).toContain('森林金币 2');
      expect(html.match(/<script /gu)).toHaveLength(2);
      expect(html).toContain('id="ludoready-host-stage"');
      expect(html).toContain('src="./viewport.js"');
      expect(await readFile(join(project, 'public/viewport.js'), 'utf8')).toContain('ResizeObserver');
      const route = JSON.parse(await readFile(join(project, '.ludoready/playtest.json'), 'utf8'));
      expect(route.journey[0]).toMatchObject({ id: 'ready', action: 'launch', inputs: [{ type: 'wait', ms: 10000 }, { type: 'wait', ms: 8000 }] });
      expect(route.journey[1].observe[0].baselineStepId).toBe('ready');
      expect(route.journey[0].observe[0]).not.toHaveProperty('value');
      expect(route.journey[0].observe[0]).not.toHaveProperty('baselineStepId');
      expect(route.success[0]).not.toHaveProperty('value');
      expect(route.success[0]).not.toHaveProperty('baselineStepId');
      const assets = JSON.parse(await readFile(join(project, 'production-assets.json'), 'utf8'));
      expect(assets.map((asset: { role: string }) => asset.role)).toEqual(['background', 'player', 'pickup']);
      const sprite = PNG.sync.read(await readFile(join(project, 'public/assets/images/player-0.png')));
      expect(sprite.data[3]).toBe(0);
      const history = JSON.parse(await readFile(join(project, 'production-history.json'), 'utf8'));
      expect(history.find((entry: { role: string }) => entry.role === 'preflight-error').result).toMatchObject({ role: 'host', attempt: 0, message: '游戏代码未使用 player 的素材。' });
      expect(history.filter((entry: { role: string }) => entry.role === 'playtest')).toHaveLength(1);
      mock.setReuse();
      await generateGame({ ...job, revision: 1, changePrompt: '增加分数显示' }, config, async () => undefined);
      expect(mock.imageCalls).toBe(2);
      expect(await readFile(join(project, 'public/index.html'), 'utf8')).toContain('森林金币 3');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses reviewer-only success and preserves the previous public version after bounded failed repairs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-production-fail-'));
    try {
      const mock = responses({ failHost: true });
      const job = { id: '00000000-0000-4000-8000-000000000002', prompt: '森林金币', changePrompt: '修改游戏' } as Job;
      const project = join(root, 'projects', job.id);
      await mkdir(join(project, 'public'), { recursive: true });
      for (const [file, content] of [['index.html', '<h1>上一版</h1>'], ['style.css', ''], ['game.js', '']]) await writeFile(join(project, 'public', file), content);
      await expect(generateGame(job, { dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest }, async () => undefined)).rejects.toThrow('3 轮修复');
      expect(mock.roles.filter((role) => role === 'repair')).toHaveLength(3);
      expect(await readFile(join(project, 'public/index.html'), 'utf8')).toBe('<h1>上一版</h1>');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a string review boolean before it can regenerate art or publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-review-format-'));
    try {
      const mock = responses({ failHost: true, invalidReviewBoolean: true });
      await expect(generateGame({ id: 'review-format', prompt: '森林金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined)).rejects.toThrow('response/regenerateArt must be boolean');
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'reviewer', 'repair', 'reviewer', 'repair', 'reviewer', 'repair', 'reviewer']);
      expect(mock.imageCalls).toBe(2);
      await expect(readFile(join(root, 'projects/review-format/public/index.html'), 'utf8')).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses an existing repair round after invalid JSON and preserves the last valid output and host findings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-format-repair-'));
    try {
      const mock = responses({ failHostOnce: true, invalidFormats: [null, 'syntax'] });
      const job = { id: 'format-repair', prompt: '森林金币' } as Job;
      await generateGame(job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined);
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'reviewer', 'repair', 'repair', 'reviewer']);
      expect(mock.playtest).toHaveBeenCalledTimes(2);
      expect(mock.imageCalls).toBe(2);
      const requests = mock.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions')).map(([, init]) => JSON.parse(String(init?.body)));
      const repairs = requests.filter((request) => request.response_format.json_schema.name === 'ludoready_repair');
      const nextRequest = repairs[1].messages[1].content[0].text as string;
      expect(JSON.parse(nextRequest.split('CURRENT IMPLEMENTATION\n')[1].split('\nAUTHORITATIVE FINDINGS')[0]).title).toBe('森林金币 1');
      expect(nextRequest).toContain('没有实际操作反馈');
      expect(nextRequest).toContain('JSON 无法解析');
      expect(await readFile(join(root, 'projects', job.id, 'public/index.html'), 'utf8')).toContain('森林金币 3');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('bounds consecutive syntax and missing-field failures to one implementation and three repairs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-format-budget-'));
    try {
      const mock = responses({ invalidFormats: ['syntax', 'structure', 'syntax', 'structure'] });
      await expect(generateGame({ id: 'format-budget', prompt: '森林金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined)).rejects.toThrow('3 轮修复');
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'repair', 'repair', 'repair']);
      expect(mock.playtest).not.toHaveBeenCalled();
      expect(mock.imageCalls).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('repairs a missing reviewer field using the same images, code and passing host evidence without rewriting the game', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-review-only-'));
    try {
      const mock = responses({ invalidReviews: ['missing', null], diagnosticSecret: 'private-test-key' });
      const messages: string[] = [];
      await generateGame({ id: 'review-only', prompt: '森林金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'private-test-key', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async (_stage, message) => { messages.push(message); });
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'reviewer', 'reviewer']);
      expect(mock.playtest).toHaveBeenCalledTimes(1);
      expect(mock.imageCalls).toBe(2);
      const reviews = mock.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))
        .map(([, init]) => JSON.parse(String(init?.body))).filter((request) => request.response_format.json_schema.name === 'ludoready_reviewer');
      expect(reviews[1].messages[1].content.slice(1)).toEqual(reviews[0].messages[1].content.slice(1));
      const reviewText = (index: number) => reviews[index].messages[1].content[0].text as string;
      expect(reviewText(1).split('ACTUAL SOURCE\n')[1].split('\nHOST FINDINGS')[0]).toBe(reviewText(0).split('ACTUAL SOURCE\n')[1].split('\nHOST FINDINGS')[0]);
      expect(reviewText(1).split('HOST REPORT\n')[1].split('\nPREVIOUS REVIEW')[0]).toBe(reviewText(0).split('HOST REPORT\n')[1].split('\nPREVIOUS REVIEW')[0]);
      expect(reviewText(1)).toContain("required property 'regenerateArt'");
      const historyText = await readFile(join(root, 'projects/review-only/production-history.json'), 'utf8');
      const error = JSON.parse(historyText).find((entry: { role: string }) => entry.role === 'response-format-error').result;
      expect(error).toMatchObject({ role: 'reviewer', attempt: 0, responseKeys: ['verdict', 'summary', 'findings'] });
      expect(error.response).toContain('[已隐藏]');
      expect(historyText).not.toContain('private-test-key');
      expect(messages.join('\n')).toContain("required property 'regenerateArt'");
      expect(messages.join('\n')).not.toContain('private-test-key');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('bounds reviewer-only format repair to three rounds and never publishes an incomplete review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-review-budget-'));
    try {
      const mock = responses({ invalidReviews: ['missing', 'missing', 'missing', 'missing'] });
      await expect(generateGame({ id: 'review-budget', prompt: '森林金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined)).rejects.toThrow("required property 'regenerateArt'");
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'reviewer', 'reviewer', 'reviewer', 'reviewer']);
      expect(mock.playtest).toHaveBeenCalledTimes(1);
      expect(mock.imageCalls).toBe(2);
      await expect(readFile(join(root, 'projects/review-budget/public/index.html'), 'utf8')).rejects.toThrow();
      const history = JSON.parse(await readFile(join(root, 'projects/review-budget/.production/work/production-history.json'), 'utf8'));
      expect(history.filter((entry: { role: string }) => entry.role === 'response-format-error').map((entry: { result: { attempt: number } }) => entry.result.attempt)).toEqual([0, 1, 2, 3]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('corrects an explicit thirty-second plan before image generation and counts that correction within the shared repair budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-plan-duration-'));
    try {
      const mock = responses({ failHost: true, plans: [
        { durationSeconds: 60, summary: '60秒限时收集金币', rules: '限时60秒，三次失误结束' },
        { durationSeconds: 30, summary: '30秒限时收集金币', rules: '限时30秒，三次失误结束' },
      ] });
      await expect(generateGame({ id: 'plan-duration', prompt: '方向键移动，限时30秒，三次失误结束' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined)).rejects.toThrow('3 轮修复');
      expect(mock.roles).toEqual(['planner', 'planner', 'requirements', 'implementer', 'reviewer', 'repair', 'reviewer', 'repair', 'reviewer']);
      const chats = mock.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions')).map(([, init]) => JSON.parse(String(init?.body)));
      expect(chats[1].messages[1].content[0].text).toContain('用户明确要求的 30 秒时长');
      expect(chats[1].messages[0].content).toContain('30 seconds exactly');
      const firstImage = mock.fetchMock.mock.calls.findIndex(([url]) => String(url).endsWith('/images/generations'));
      expect(firstImage).toBe(3);
      const history = JSON.parse(await readFile(join(root, 'projects/plan-duration/.production/work/production-history.json'), 'utf8'));
      expect(history.find((entry: { role: string }) => entry.role === 'plan-error').result.message).toContain('30 秒');
      expect(JSON.parse(await readFile(join(root, 'projects/plan-duration/.production/work/production-plan.json'), 'utf8')).durationSeconds).toBe(30);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a plan that claims thirty seconds in metadata but still describes sixty seconds, before paying for art', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-plan-conflict-'));
    try {
      const conflicting = { durationSeconds: 30, rules: '60秒限时挑战，时间到结束' };
      const mock = responses({ plans: [conflicting, conflicting] });
      await expect(generateGame({ id: 'plan-conflict', prompt: '每局30秒，方向键接金币' } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined)).rejects.toThrow('用户明确要求的 30 秒');
      expect(mock.roles).toEqual(['planner', 'planner']);
      expect(mock.imageCalls).toBe(0);
      expect(mock.playtest).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { prompt: '每局30秒，接金币', changePrompt: '把时长改成1分钟，按住方向键3秒移动', duration: 60 },
    { prompt: '游戏开始后按住方向键3秒移动', changePrompt: null, duration: null },
    { prompt: '倒计时半分钟，方向键接金币', changePrompt: null, duration: 30 },
  ])('binds the latest explicit round duration without confusing input waits: $prompt', async ({ prompt, changePrompt, duration }) => {
    const root = await mkdtemp(join(tmpdir(), 'ludoready-duration-context-'));
    try {
      const mock = responses({ plans: [{ durationSeconds: duration, rules: duration ? `限时${duration}秒，三次失误结束` : plan.rules }] });
      await generateGame({ id: 'duration-context', prompt, changePrompt } as Job, {
        dataDir: root, baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: mock.fetchMock as typeof fetch, playtest: mock.playtest,
      }, async () => undefined);
      expect(mock.roles).toEqual(['planner', 'requirements', 'implementer', 'reviewer']);
      const first = JSON.parse(String(mock.fetchMock.mock.calls[0][1]?.body));
      expect(first.messages[0].content).toContain(`HOST REQUIRED ROUND DURATION: ${duration === null ? 'unspecified' : `${duration} seconds exactly`}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
