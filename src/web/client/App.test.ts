import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fetchProjectDownload, getPipelineProgress, requestProduction, RevisionForm } from './App';

type Progress = NonNullable<Parameters<typeof getPipelineProgress>[0]>;
const project = (status: Progress['status'], stages: string[], revision = 0): Progress => ({
  status, stage: status === 'failed' ? '制作中断' : stages.at(-1) ?? '准备制作', revision,
  events: stages.map((stage, index) => ({ stage, message: stage, time: String(index), revision })),
});
const stages = ['准备制作', '规划游戏', '绘制素材', '制作玩法', '审查游戏', '试玩检查', '审查游戏'];

describe('failed project continuation', () => {
  const form = (status: 'failed' | 'complete' | 'queued' | 'running', canPlay = false) => renderToStaticMarkup(createElement(RevisionForm, {
    project: { status, revision: 0 }, canPlay, changePrompt: '保留现有素材，修复开始按钮', revising: false,
    error: null, onChange: () => {}, onSubmit: () => {},
  }));

  it('shows a usable modification form for failed first productions without a playable version', () => {
    const markup = form('failed');
    expect(markup).toContain('<h2>继续修改</h2>');
    expect(markup).toContain('id="change-prompt"');
    expect(markup).toContain('开始修改');
    expect(markup).toContain('保留当前项目和修改记录');
    expect(markup).toContain('每天共 20 次');
    expect(markup).not.toContain('重新制作');
    expect(markup).not.toContain('disabled');
  });

  it('keeps the previous-version message after failed modifications and hides input while producing', () => {
    expect(form('failed', true)).toContain('仍可试玩上次完成的版本');
    expect(form('running')).toBe('');
    expect(form('queued')).toBe('');
  });
});

describe('Web production gate status', () => {
  it('does not treat an executed playtest as passed while the reviewer is still running', () => {
    const progress = getPipelineProgress(project('running', stages));
    expect(progress[4]).toEqual({ state: 'active', detail: '进行中' });
    expect(progress[5]).toEqual({ state: 'executed', detail: '已执行，待验收' });
    expect(progress.some((stage) => stage.state === 'passed')).toBe(false);
  });

  it('keeps both review and playtest unapproved when the final repair still fails', () => {
    const progress = getPipelineProgress(project('failed', [...stages, '修复游戏', '审查游戏', '试玩检查', '审查游戏']));
    expect(progress[4]).toEqual({ state: 'failed', detail: '未通过验收' });
    expect(progress[5]).toEqual({ state: 'unapproved', detail: '未通过验收' });
    expect(progress.some((stage) => stage.state === 'passed')).toBe(false);
  });

  it('requires fresh checks after a repair instead of carrying forward earlier checks', () => {
    const progress = getPipelineProgress(project('running', [...stages, '修复游戏']));
    expect(progress[4]).toEqual({ state: 'recheck', detail: '等待复查' });
    expect(progress[5]).toEqual({ state: 'recheck', detail: '等待复查' });
    expect(progress[6]).toEqual({ state: 'active', detail: '进行中' });
  });

  it('shows passes only after a completed delivery and excludes earlier revisions', () => {
    const complete = project('complete', [...stages, '制作完成']);
    expect(getPipelineProgress(complete)[4]).toEqual({ state: 'passed', detail: '已通过' });
    expect(getPipelineProgress(complete)[5]).toEqual({ state: 'passed', detail: '已通过' });
    expect(getPipelineProgress(complete)[6]).toEqual({ state: 'skipped', detail: '无需修复' });
    const revision = project('running', ['准备制作', '规划游戏'], 1);
    revision.events = [...complete.events, ...revision.events];
    expect(getPipelineProgress(revision)[5]?.state).toBe('waiting');
  });
});

const origin = 'https://games.example.com';
const run = { url: '/produce', id: 'project-1', revision: 0 };
const attempts = (): Parameters<typeof requestProduction>[1] => new Map();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mockTransport() {
  vi.stubGlobal('window', { location: { href: `${origin}/?project=project-1`, origin } });
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Web production transport', () => {
  it('keeps local jobs unchanged and consumes the complete stream with one request per revision', async () => {
    const fetchMock = mockTransport();
    const requests = attempts();
    expect(await requestProduction(undefined, requests)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
    let settled = false;
    const producing = requestProduction(run, requests).then((result) => { settled = true; return result; });
    controller.enqueue(new TextEncoder().encode('data: {"progress":1}\n\n'));
    await vi.waitFor(() => expect(stream.locked).toBe(true));
    expect(settled).toBe(false);
    expect(await requestProduction(run, requests, true)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${origin}/produce`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Makers-Conversation-Id': 'project-1' },
      body: JSON.stringify({ id: 'project-1', revision: 0 }),
    });

    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    controller.close();
    expect(await producing).toBe(true);
    expect(stream.locked).toBe(false);
    expect(await requestProduction(run, requests)).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    expect(await requestProduction({ ...run, revision: 1 }, requests)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not silently restart a broken stream, but allows an explicit reconnect', async () => {
    const fetchMock = mockTransport();
    const requests = attempts();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error('连接中断')); } })));
    await expect(requestProduction(run, requests)).rejects.toThrow('连接中断');
    expect(await requestProduction(run, requests)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    expect(await requestProduction(run, requests, true)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits 30 seconds before reconnecting a platform 429, even after an explicit retry', async () => {
    const fetchMock = mockTransport();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    const requests = attempts();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(requestProduction(run, requests)).rejects.toThrow('稍后再试');
    vi.advanceTimersByTime(29_999);
    expect(await requestProduction(run, requests, true)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    fetchMock.mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    expect(await requestProduction(run, requests)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a production URL outside the website before sending authenticated requests', async () => {
    const fetchMock = mockTransport();
    await expect(requestProduction({ ...run, url: 'https://other.example.com/produce' }, attempts())).rejects.toThrow('无法连接制作服务');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Web project downloads', () => {
  it('downloads the original ZIP response with its filename and project cookie', async () => {
    const fetchMock = mockTransport();
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([80, 75, 3, 4]), { headers: {
      'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="ludoready-project-1.zip"',
    } }));
    const archive = await fetchProjectDownload('/api/projects/project-1/download');
    expect(archive.filename).toBe('ludoready-project-1.zip');
    expect([...new Uint8Array(await archive.blob.arrayBuffer())]).toEqual([80, 75, 3, 4]);
    expect(fetchMock).toHaveBeenCalledWith(`${origin}/api/projects/project-1/download`, { credentials: 'same-origin', cache: 'no-store' });
  });

  it('fetches authenticated chunks sequentially and combines the ZIP bytes in order', async () => {
    const fetchMock = mockTransport();
    let finishFirst!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(Response.json({ filename: 'ludoready-project-1.zip', chunks: [
      { url: '/api/projects/project-1/download/0?v=0', size: 2 },
      { url: '/api/projects/project-1/download/1?v=0', size: 3 },
    ] }));
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([3, 4, 5])));
    const downloading = fetchProjectDownload('/api/projects/project-1/download');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    finishFirst(new Response(new Uint8Array([80, 75])));
    const archive = await downloading;
    expect(archive.filename).toBe('ludoready-project-1.zip');
    expect(archive.blob.type).toBe('application/zip');
    expect([...new Uint8Array(await archive.blob.arrayBuffer())]).toEqual([80, 75, 3, 4, 5]);
    expect(fetchMock.mock.calls.slice(1)).toEqual([
      [`${origin}/api/projects/project-1/download/0?v=0`, { credentials: 'same-origin', cache: 'no-store' }],
      [`${origin}/api/projects/project-1/download/1?v=0`, { credentials: 'same-origin', cache: 'no-store' }],
    ]);
  });

  it('does not save an incomplete archive or request off-site chunks', async () => {
    const fetchMock = mockTransport();
    fetchMock.mockResolvedValueOnce(Response.json({ filename: 'project.zip', chunks: [{ url: '/chunk/0', size: 4 }, { url: '/chunk/1', size: 1 }] }));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([80, 75])));
    await expect(fetchProjectDownload('/download')).rejects.toThrow('下载未完成');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(Response.json({ filename: 'project.zip', chunks: [{ url: 'https://other.example.com/chunk', size: 4 }] }));
    await expect(fetchProjectDownload('/download')).rejects.toThrow('下载未完成');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
