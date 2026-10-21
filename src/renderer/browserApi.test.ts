import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeDesktopConnectionKey, createBrowserDesktopApi, DesktopConnectionError, fetchDesktopProjectArchive } from './browserApi';

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('browser desktop connection', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends existing desktop channels and approval answers to the same-origin owner', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response({ result: { id: 'project-1' } }));
    const bridge = createBrowserDesktopApi({ fetch: request });
    await bridge.api.runProject({ projectId: 'project-1', prompt: '加一个暂停按钮' });
    await bridge.api.resolveApproval('approval-1', 'decline', { theme: ['森林'] });
    expect(request.mock.calls.map(([path, options]) => [path, JSON.parse(String(options?.body))])).toEqual([
      ['/desktop/rpc', { channel: 'ludoready:project:run', args: [{ projectId: 'project-1', prompt: '加一个暂停按钮' }] }],
      ['/desktop/rpc', { channel: 'ludoready:approval:resolve', args: ['approval-1', 'decline', { theme: ['森林'] }] }],
    ]);
    expect(request.mock.calls[0][1]?.credentials).toBe('same-origin');
    expect(bridge.getConnection().connected).toBe(true);
  });

  it('waits for remote upload and request results before creating a real desktop project', async () => {
    let uploadChecks = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      switch (String(path)) {
        case '/desktop/upload': return response({ requestId: 'upload-1' });
        case '/desktop/result/upload-1': return response(++uploadChecks === 1
          ? { pending: true }
          : { pending: false, result: { paths: ['/owner/upload/bird.png'] } });
        case '/desktop/rpc': return response({ requestId: 'create-1' });
        case '/desktop/result/create-1': return response({ pending: false, result: { id: 'desktop-project' } });
        default: throw new Error(`Unexpected path: ${String(path)}`);
      }
    });
    const bridge = createBrowserDesktopApi({ fetch: request, encodeFile: async () => 'cG5n', pollIntervalMs: 1 });
    const project = await bridge.api.createProject({ idea: '小鸟', projectDirectory: '/owner/games/bird' }, [new File(['png'], 'bird.png')]);
    expect(project.id).toBe('desktop-project');
    const uploadCall = request.mock.calls.find(([path]) => path === '/desktop/upload');
    expect(JSON.parse(String(uploadCall?.[1]?.body))).toEqual({ files: [{ name: 'bird.png', data: 'cG5n' }] });
    const createCall = request.mock.calls.find(([path]) => path === '/desktop/rpc');
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      channel: 'ludoready:project:create',
      args: [{ idea: '小鸟', projectDirectory: '/owner/games/bird' }, ['/owner/upload/bird.png']],
    });
  });

  it('transfers large cloud attachments in ordered UTF8 byte chunks and preserves multibyte file names', async () => {
    const fileBytes = Buffer.alloc(Math.ceil(2.4 * 1024 * 1024), 1);
    const fileData = fileBytes.toString('base64');
    const parts: { id: string; index: number; count: number; dataBase64: string }[] = [];
    let commit: { uploadParts: string; count: number } | undefined;
    const request = vi.fn<typeof fetch>().mockImplementation(async (path, options) => {
      const input = options?.body ? JSON.parse(String(options.body)) : null;
      if (path === '/desktop/upload-part') { parts.push(input); return response({ ok: true }); }
      if (path === '/desktop/upload') { commit = input; return response({ requestId: 'large-upload' }); }
      if (path === '/desktop/result/large-upload') return response({ pending: false, result: { paths: ['/owner/upload/小鸟🎮.png'] } });
      return response({ result: { id: 'project-1' } });
    });
    const bridge = createBrowserDesktopApi({ fetch: request, encodeFile: async () => fileData, chunkUploads: true });
    await bridge.api.createProject({ idea: '小鸟', projectDirectory: '/owner/games/bird' }, [new File([fileBytes], '小鸟🎮.png')]);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => part.index)).toEqual(parts.map((_, index) => index));
    expect(parts.every((part) => part.id === parts[0].id && part.count === parts.length)).toBe(true);
    expect(parts.every((part) => Buffer.from(part.dataBase64, 'base64').byteLength <= 512 * 1024)).toBe(true);
    const reconstructed = Buffer.concat(parts.map((part) => Buffer.from(part.dataBase64, 'base64'))).toString('utf8');
    expect(JSON.parse(reconstructed)).toEqual({ files: [{ name: '小鸟🎮.png', data: fileData }] });
    expect(commit).toEqual({ uploadParts: parts[0].id, count: parts.length });
    const createCall = request.mock.calls.find(([path]) => path === '/desktop/rpc');
    expect(JSON.parse(String(createCall?.[1]?.body)).args[1]).toEqual(['/owner/upload/小鸟🎮.png']);

    const localRequest = vi.fn<typeof fetch>().mockImplementation(async (path) => response(path === '/desktop/upload'
      ? { paths: ['/owner/upload/bird.png'] }
      : { result: { id: 'local-project' } }));
    const local = createBrowserDesktopApi({ fetch: localRequest, encodeFile: async () => fileData, chunkUploads: false });
    await local.api.createProject({ idea: '小鸟', projectDirectory: '/owner/games/bird' }, [new File([fileBytes], 'bird.png')]);
    expect(localRequest.mock.calls.map(([path]) => path)).toEqual(['/desktop/upload', '/desktop/rpc']);
  });

  it('rejects more than 20MB of attachments before encoding or sending any file', async () => {
    const request = vi.fn<typeof fetch>();
    const encodeFile = vi.fn(async () => '');
    const bridge = createBrowserDesktopApi({ fetch: request, encodeFile });
    const file = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.png');
    await expect(bridge.api.createProject({ idea: '小鸟', projectDirectory: '/owner/games/bird' }, [file]))
      .rejects.toThrow('附件总大小最多 20MB');
    expect(encodeFile).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('shows a connection key requirement on denied access and never stores the key', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ error: '请输入连接密钥' }, 401));
    const bridge = createBrowserDesktopApi({ fetch: request });
    await expect(bridge.api.bootstrap()).rejects.toBeInstanceOf(DesktopConnectionError);
    expect(bridge.getConnection()).toEqual({ connected: false, requiresKey: true, message: '请输入连接密钥' });
    request.mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ connected: true, events: [], cursor: 12 }))
      .mockResolvedValueOnce(response({ result: { projects: [] } }));
    await bridge.connect('  secret-key  ');
    expect(request.mock.calls[1][0]).toBe('/desktop/connect');
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({ token: 'secret-key' });
    expect(bridge.getConnection().connected).toBe(true);
  });

  it('delivers project and approval events through the desktop API and stops when unsubscribed', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (path) => path === '/desktop/events?latest=1'
      ? response({ connected: true, cursor: 10, events: [] })
      : response({
      connected: true,
      cursor: 12,
      events: [
        { id: 11, channel: 'ludoready:event:project', payload: { id: 'project-1', status: 'running' } },
        { id: 12, channel: 'ludoready:event:approval', payload: { token: 'approval-1', title: '允许本次操作？' } },
      ],
    }));
    const bridge = createBrowserDesktopApi({ fetch: request, pollIntervalMs: 10_000 });
    const project = vi.fn();
    const approval = vi.fn();
    const stopProject = bridge.api.onProjectChanged(project);
    const stopApproval = bridge.api.onApproval(approval);
    await vi.waitFor(() => expect(approval).toHaveBeenCalledWith({ token: 'approval-1', title: '允许本次操作？' }));
    expect(project).toHaveBeenCalledWith({ id: 'project-1', status: 'running' });
    stopProject();
    stopApproval();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe('/desktop/events?latest=1');
    expect(request.mock.calls[1][0]).toBe('/desktop/events?after=10');
  });

  it('primes the event cursor once before bootstrap and subscriptions so old history cannot replace current projects', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (path === '/desktop/events?latest=1') return response({ cursor: 50, events: [
        { id: 49, channel: 'ludoready:event:project', payload: { id: 'project-1', status: 'running' } },
      ] });
      if (path === '/desktop/rpc') return response({ result: { projects: [{ id: 'project-1', status: 'completed' }] } });
      return response({ connected: true, cursor: 51, events: [
        { id: 51, channel: 'ludoready:event:approval', payload: { token: 'active-approval' } },
      ] });
    });
    const bridge = createBrowserDesktopApi({ fetch: request, pollIntervalMs: 10_000 });
    const bootstrap = bridge.api.bootstrap();
    const project = vi.fn();
    const approval = vi.fn();
    const stopProject = bridge.api.onProjectChanged(project);
    const stopApproval = bridge.api.onApproval(approval);
    expect((await bootstrap).projects).toEqual([{ id: 'project-1', status: 'completed' }]);
    await vi.waitFor(() => expect(approval).toHaveBeenCalledWith({ token: 'active-approval' }));
    expect(project).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([path]) => path === '/desktop/events?latest=1')).toHaveLength(1);
    expect(request.mock.calls[0][0]).toBe('/desktop/events?latest=1');
    expect(request.mock.calls.map(([path]) => path)).toContain('/desktop/events?after=50');
    stopProject();
    stopApproval();
  });

  it('reduces idle event requests to one per 15 seconds in front and 30 seconds in a hidden tab', async () => {
    vi.useFakeTimers();
    const visibility = new EventTarget();
    vi.stubGlobal('document', visibility);
    let hidden = false;
    const request = vi.fn<typeof fetch>().mockImplementation(async (path) => path === '/desktop/events?latest=1'
      ? response({ cursor: 0 })
      : response({ connected: true, cursor: 0, events: [] }));
    const bridge = createBrowserDesktopApi({ fetch: request, isHidden: () => hidden });
    const stop = bridge.api.onProjectChanged(vi.fn());
    const eventCalls = () => request.mock.calls.filter(([path]) => String(path).startsWith('/desktop/events?after=')).length;

    await vi.advanceTimersByTimeAsync(0);
    expect(eventCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(eventCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(eventCalls()).toBe(2);

    hidden = true;
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(eventCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(eventCalls()).toBe(3);

    hidden = false;
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(eventCalls()).toBe(4);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(eventCalls()).toBe(4);
  });

  it('keeps running and waiting projects at one-second foreground cadence, then returns to idle cadence', async () => {
    vi.useFakeTimers();
    let eventPolls = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (path === '/desktop/events?latest=1') return response({ cursor: 0 });
      if (path === '/desktop/rpc') return response({ result: { projects: [{ id: 'project-1', status: 'running' }] } });
      eventPolls++;
      return response({ connected: true, cursor: eventPolls, events: eventPolls === 2
        ? [{ id: eventPolls, channel: 'ludoready:event:project', payload: { id: 'project-1', status: 'waiting' } }]
        : eventPolls === 3
          ? [{ id: eventPolls, channel: 'ludoready:event:project', payload: { id: 'project-1', status: 'completed' } }]
          : [] });
    });
    const bridge = createBrowserDesktopApi({ fetch: request });
    await bridge.api.bootstrap();
    const stop = bridge.api.onProjectChanged(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(eventPolls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(eventPolls).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(eventPolls).toBe(3);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(eventPolls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(eventPolls).toBe(4);
    stop();
  });

  it('refreshes events immediately on an idle project action and backs off while disconnected', async () => {
    vi.useFakeTimers();
    let disconnected = false;
    const request = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (path === '/desktop/events?latest=1') return response({ cursor: 0 });
      if (path === '/desktop/rpc') return response({ result: { files: [] } });
      return response({ connected: !disconnected, cursor: 0, events: [] });
    });
    const bridge = createBrowserDesktopApi({ fetch: request });
    const stop = bridge.api.onProjectChanged(vi.fn());
    const eventCalls = () => request.mock.calls.filter(([path]) => String(path).startsWith('/desktop/events?after=')).length;
    await vi.advanceTimersByTimeAsync(0);
    expect(eventCalls()).toBe(1);
    await bridge.api.inspectProject('project-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(eventCalls()).toBe(2);

    disconnected = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(eventCalls()).toBe(3);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(eventCalls()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(eventCalls()).toBe(4);
    stop();
  });

  it('clears only the connection key from the fragment before making a connection', () => {
    const replaceState = vi.fn();
    expect(consumeDesktopConnectionKey({ pathname: '/', search: '?project=p1', hash: '#connect=secret&view=preview' }, { replaceState })).toBe('secret');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?project=p1#view=preview');
  });

  it('preserves existing project assets when the browser file picker is cancelled', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ result: { assets: [{ id: 'existing-bird' }] } }));
    const bridge = createBrowserDesktopApi({ fetch: request, pickFiles: async () => [] });
    expect(await bridge.api.importProjectAssets('project-1')).toEqual([{ id: 'existing-bird' }]);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ channel: 'ludoready:project:inspect', args: ['project-1'] });
  });

  it('downloads a direct local archive and assembles large cloud archive chunks in order', async () => {
    const localRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response('zip-bytes', { headers: { 'Content-Type': 'application/zip' } }));
    const local = await fetchDesktopProjectArchive('project-1', localRequest);
    expect(await local.blob.text()).toBe('zip-bytes');

    const cloudRequest = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (path === '/desktop/download/project-1') return response({ filename: 'bird.zip', chunks: [
        { url: '/desktop/download-chunk/request-1/0' },
        { url: '/desktop/download-chunk/request-1/1' },
      ] });
      return new Response(String(path).endsWith('/0') ? 'first' : 'second');
    });
    const cloud = await fetchDesktopProjectArchive('project-1', cloudRequest);
    expect(cloud.filename).toBe('bird.zip');
    expect(await cloud.blob.text()).toBe('firstsecond');
    expect(cloudRequest.mock.calls.every(([, options]) => options?.credentials === 'same-origin')).toBe(true);
  });
});
