import type { BootstrapPayload, LudoReadyApi } from '../shared/contracts';

export interface DesktopConnectionState {
  connected: boolean;
  requiresKey: boolean;
  message: string;
}

export class DesktopConnectionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface DesktopEvent {
  id: string | number;
  channel: string;
  payload: unknown;
}

interface BrowserApiOptions {
  fetch?: typeof fetch;
  pickFiles?: () => Promise<File[]>;
  encodeFile?: (file: File) => Promise<string>;
  pollIntervalMs?: number;
  chunkUploads?: boolean;
  isHidden?: () => boolean;
}

/** The browser exposes the same API as Electron preload; the desktop remains its owner. */
export function createBrowserDesktopApi(options: BrowserApiOptions = {}) {
  const request = options.fetch ?? window.fetch.bind(window);
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const connectionListeners = new Set<(state: DesktopConnectionState) => void>();
  let state: DesktopConnectionState = { connected: false, requiresKey: false, message: '正在连接本机工作台…' };
  let cursor = '';
  let cursorReady = false;
  let primePromise: Promise<void> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let pollAgain = false;
  let pendingInvocations = 0;
  const activeProjects = new Set<string>();

  function isHidden() {
    return options.isHidden?.() ?? (typeof document !== 'undefined' && document.hidden);
  }

  function pollDelay() {
    const base = options.pollIntervalMs ?? 1_000;
    if (!state.connected) return Math.max(base, isHidden() ? 60_000 : 30_000);
    if (pendingInvocations > 0 || activeProjects.size > 0) return Math.max(base, isHidden() ? 5_000 : 1_000);
    return Math.max(base, isHidden() ? 30_000 : 15_000);
  }

  function schedulePoll(delay = pollDelay()) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
    if (hasSubscribers()) pollTimer = setTimeout(() => void poll(), delay);
  }

  function wakePoll() {
    if (!hasSubscribers()) return;
    if (polling) pollAgain = true;
    else schedulePoll(0);
  }

  function observeProject(value: unknown) {
    if (!value || typeof value !== 'object' || !('id' in value) || !('status' in value)) return;
    const { id, status } = value;
    if (typeof id !== 'string') return;
    if (status === 'running' || status === 'waiting') activeProjects.add(id);
    else if (status === 'draft' || status === 'completed' || status === 'failed' || status === 'stopped') activeProjects.delete(id);
  }

  function onVisibilityChange() {
    if (!hasSubscribers()) return;
    if (isHidden()) {
      if (!polling) schedulePoll();
    } else {
      wakePoll();
    }
  }

  function updateConnection(next: DesktopConnectionState) {
    if (state.connected === next.connected && state.requiresKey === next.requiresKey && state.message === next.message) return;
    state = next;
    for (const listener of connectionListeners) listener(state);
  }

  function failed(reason: unknown) {
    updateConnection({
      connected: false,
      requiresKey: reason instanceof DesktopConnectionError && (reason.status === 401 || reason.status === 403),
      message: reason instanceof Error ? reason.message : '无法连接本机工作台',
    });
  }

  async function json<T>(path: string, body?: unknown): Promise<T> {
    try {
      const response = await request(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = data && typeof data === 'object' && 'error' in data ? String(data.error) : '';
        throw new DesktopConnectionError(error || (
          response.status === 401 || response.status === 403
            ? '请输入本机工作台的连接密钥'
            : '本机工作台暂时离线，请保持电脑开机并运行 PlayReady'
        ), response.status);
      }
      if (data === null) throw new Error('本机工作台返回了无法读取的响应');
      return data as T;
    } catch (reason) {
      failed(reason);
      throw reason;
    }
  }

  async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    pendingInvocations++;
    wakePoll();
    try {
      const response = await waitForResult<{ result?: T; error?: string }>(
        await json('/desktop/rpc', { channel, args }),
      );
      if (response.error) throw new Error(response.error);
      updateConnection({ connected: true, requiresKey: false, message: '' });
      if (channel === 'ludoready:project:run' || channel === 'ludoready:project:stop' || channel === 'ludoready:project:create') {
        observeProject(response.result);
      } else if (channel === 'ludoready:project:delete' && typeof args[0] === 'string') {
        activeProjects.delete(args[0]);
      }
      return response.result as T;
    } finally {
      pendingInvocations--;
      wakePoll();
    }
  }

  async function waitForResult<T>(response: T | { requestId: string }): Promise<T> {
    if (!response || typeof response !== 'object' || !('requestId' in response)) return response as T;
    const deadline = Date.now() + 10 * 60_000;
    const requestId = String(response.requestId);
    while (Date.now() < deadline) {
      const result = await json<T & { pending: boolean }>(`/desktop/result/${encodeURIComponent(requestId)}`);
      if (!result.pending) return result;
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 1_000));
    }
    throw new Error('工作台仍在处理请求，请查看制作记录后再继续');
  }

  function hasSubscribers() {
    return [...listeners.values()].some((items) => items.size > 0);
  }

  async function primeEventCursor() {
    if (cursorReady) return;
    if (!primePromise) {
      primePromise = (async () => {
        const response = await json<{ cursor: string | number }>('/desktop/events?latest=1');
        cursor = String(response.cursor ?? '');
        cursorReady = true;
      })().finally(() => { primePromise = null; });
    }
    await primePromise;
  }

  async function poll() {
    if (polling || !hasSubscribers()) return;
    polling = true;
    try {
      await primeEventCursor();
      const response = await json<{ events: DesktopEvent[]; cursor: string | number; connected: boolean }>(
        `/desktop/events?after=${encodeURIComponent(cursor)}`,
      );
      if (!Array.isArray(response.events)) throw new Error('本机工作台没有返回制作记录');
      cursor = String(response.cursor ?? cursor);
      updateConnection({
        connected: response.connected !== false,
        requiresKey: false,
        message: response.connected === false ? '本机工作台暂时离线，请保持电脑开机并运行 PlayReady' : '',
      });
      for (const event of response.events) {
        if (event.channel === 'ludoready:event:project') observeProject(event.payload);
        for (const listener of listeners.get(event.channel) ?? []) listener(event.payload);
      }
    } catch (reason) {
      failed(reason);
    } finally {
      polling = false;
      const delay = pollAgain ? 0 : pollDelay();
      pollAgain = false;
      schedulePoll(delay);
    }
  }

  function subscribe<T>(channel: string, listener: (payload: T) => void) {
    const firstSubscriber = !hasSubscribers();
    const wrapped = listener as (payload: unknown) => void;
    const channelListeners = listeners.get(channel) ?? new Set();
    channelListeners.add(wrapped);
    listeners.set(channel, channelListeners);
    if (firstSubscriber && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (!polling && !pollTimer) void poll();
    return () => {
      channelListeners.delete(wrapped);
      if (!hasSubscribers()) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }

  async function upload(files: readonly unknown[]): Promise<string[]> {
    if (!Array.isArray(files) || files.length > 50) throw new Error('一次最多上传 50 个附件');
    if (files.length === 0) return [];
    let totalBytes = 0;
    for (const value of files) {
      if (!value || typeof value !== 'object' || !('name' in value) || !('size' in value)) throw new Error('无法读取上传文件');
      const file = value as File;
      totalBytes += file.size;
    }
    if (totalBytes > 20 * 1024 * 1024) throw new Error('附件总大小最多 20MB，请减少附件后重试');
    const encoded = await Promise.all(files.map(async (value) => {
      const file = value as File;
      return { name: file.name, data: await (options.encodeFile ?? encodeBrowserFile)(file) };
    }));
    let payload: unknown = { files: encoded };
    const chunkUploads = options.chunkUploads ?? (
      typeof window === 'undefined' || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname)
    );
    if (chunkUploads) {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      if (bytes.byteLength > 3 * 1024 * 1024) {
        const id = crypto.randomUUID();
        const partBytes = 512 * 1024;
        const count = Math.ceil(bytes.byteLength / partBytes);
        for (let index = 0; index < count; index++) {
          await json('/desktop/upload-part', {
            id, index, count,
            dataBase64: encodeBytesBase64(bytes.subarray(index * partBytes, (index + 1) * partBytes)),
          });
        }
        payload = { uploadParts: id, count };
      }
    }
    const response = await waitForResult<{ paths?: string[]; result?: { paths: string[] }; error?: string }>(
      await json('/desktop/upload', payload),
    );
    if (response.error) throw new Error(response.error);
    const paths = response.paths ?? response.result?.paths;
    if (!Array.isArray(paths) || paths.length !== files.length) throw new Error('附件没有完整传到本机工作台');
    return paths;
  }

  const api: LudoReadyApi = {
    bootstrap: async () => {
      await primeEventCursor();
      const payload = await invoke<BootstrapPayload>('ludoready:bootstrap');
      activeProjects.clear();
      for (const project of payload.projects) observeProject(project);
      wakePoll();
      return payload;
    },
    refreshRuntime: () => invoke('ludoready:runtime:refresh'),
    startLogin: () => invoke('ludoready:runtime:login'),
    logout: () => invoke('ludoready:runtime:logout'),
    chooseDirectory: () => invoke('ludoready:dialog:directory'),
    chooseProjectDirectory: () => invoke('ludoready:dialog:project-directory'),
    createProject: async (input, files = []) => invoke('ludoready:project:create', input, await upload(files)),
    renameProject: (id, name) => invoke('ludoready:project:rename', id, name),
    setProjectPinned: (id, pinned) => invoke('ludoready:project:pin', id, pinned),
    deleteProject: (id) => invoke('ludoready:project:delete', id),
    runProject: (input) => invoke('ludoready:project:run', input),
    stopProject: (id) => invoke('ludoready:project:stop', id),
    revealProject: (id) => invoke('ludoready:project:reveal', id),
    importProjectAssets: async (id) => {
      const files = await (options.pickFiles ?? pickBrowserImages)();
      if (files.length === 0) return (await api.inspectProject(id)).assets;
      return invoke('ludoready:project:assets:import-paths', id, await upload(files));
    },
    importDroppedProjectAssets: async (id, files) => {
      if (!Array.isArray(files) || files.length === 0 || files.length > 50) throw new Error('一次只能拖入 1–50 张图片');
      return invoke('ludoready:project:assets:import-paths', id, await upload(files));
    },
    retryAssetPlan: (id, planId) => invoke('ludoready:project:asset-plan:retry', id, planId),
    inspectProject: (id) => invoke('ludoready:project:inspect', id),
    evaluateProjectExperience: (id) => invoke('ludoready:project:experience:evaluate', id),
    cancelProjectExperience: (id) => invoke('ludoready:project:experience:cancel', id),
    readProjectFile: (id, path) => invoke('ludoready:project:read', id, path),
    getProjectIcon: (id) => invoke('ludoready:project:icon', id),
    saveProjectLudoReadyPack: (id, packId) => invoke('ludoready:project:ludoready-pack:save', id, packId),
    saveProjectLudoReadyCrew: (id, crew) => invoke('ludoready:project:ludoready-crew:save', id, crew),
    saveSettings: (patch) => invoke('ludoready:settings:save', patch),
    getEnvironmentStatus: () => invoke('ludoready:environment:get'),
    refreshEnvironmentStatus: () => invoke('ludoready:environment:refresh'),
    chooseGodotExecutable: () => invoke('ludoready:environment:godot:choose'),
    saveGodotExecutable: (path) => invoke('ludoready:environment:godot:save', path),
    getExtensionSettings: () => invoke('ludoready:extensions:get'),
    saveMediaProvider: (input) => invoke('ludoready:media-provider:save', input),
    testMediaProvider: (capability) => invoke('ludoready:media-provider:test', capability),
    listSkills: () => invoke('ludoready:skills:list'),
    setSkillEnabled: (input) => invoke('ludoready:skills:set-enabled', input),
    listMcpServers: () => invoke('ludoready:mcp:list'),
    saveMcpServer: (input) => invoke('ludoready:mcp:save', input),
    removeMcpServer: (id) => invoke('ludoready:mcp:remove', id),
    listPromptTemplates: () => invoke('ludoready:prompts:list'),
    savePromptTemplate: (input) => invoke('ludoready:prompts:save', input),
    resetPromptTemplate: (id) => invoke('ludoready:prompts:reset', id),
    resolveApproval: (token, decision, answers) => invoke('ludoready:approval:resolve', token, decision, answers),
    onAgentEvent: (listener) => subscribe('ludoready:event:agent', listener),
    onProjectChanged: (listener) => subscribe('ludoready:event:project', listener),
    onRuntimeChanged: (listener) => subscribe('ludoready:event:runtime', listener),
    onApproval: (listener) => subscribe('ludoready:event:approval', listener),
    onApprovalClosed: (listener) => subscribe('ludoready:event:approval-closed', listener),
    onAssetsChanged: (listener) => subscribe('ludoready:event:assets', listener),
    onAssetPlansChanged: (listener) => subscribe('ludoready:event:asset-plans', listener),
  };

  return {
    api,
    getConnection: () => state,
    onConnection(listener: (value: DesktopConnectionState) => void) {
      connectionListeners.add(listener);
      return () => { connectionListeners.delete(listener); };
    },
    async connect(token: string) {
      if (!token.trim()) throw new Error('请输入连接密钥');
      await json('/desktop/connect', { token: token.trim() });
      cursor = '';
      cursorReady = false;
      return api.bootstrap();
    },
  };
}

function encodeBytesBase64(bytes: Uint8Array): string {
  const blocks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    blocks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return btoa(blocks.join(''));
}

function encodeBrowserFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取附件：${file.name}`));
    reader.onload = () => {
      const value = String(reader.result);
      const comma = value.indexOf(',');
      if (comma < 0) reject(new Error(`无法读取附件：${file.name}`));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function pickBrowserImages(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.jpg,.jpeg,.webp,.wav,.mp3,.ogg,.glb';
    input.multiple = true;
    input.hidden = true;
    const finish = (files: File[]) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

/** Connection keys stay out of requests, referrers and persistent browser storage. */
export function consumeDesktopConnectionKey(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>) {
  const values = new URLSearchParams(location.hash.slice(1));
  const token = values.get('connect');
  if (!token) return null;
  values.delete('connect');
  const remainder = values.toString();
  history.replaceState(null, '', `${location.pathname}${location.search}${remainder ? `#${remainder}` : ''}`);
  return token;
}

export async function fetchDesktopProjectArchive(projectId: string, request: typeof fetch = window.fetch.bind(window)) {
  async function get(path: string) {
    const response = await request(path, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('项目下载失败，请检查工作台连接后重试');
    return response;
  }
  const response = await get(`/desktop/download/${encodeURIComponent(projectId)}`);
  if (!response.headers.get('content-type')?.includes('application/json')) {
    return { filename: `ludoready-${projectId}.zip`, blob: await response.blob() };
  }
  const data = await response.json() as { filename: string; chunks: { url: string }[] };
  if (!Array.isArray(data.chunks) || !data.chunks.length) throw new Error('项目下载尚未准备完成，请稍后重试');
  const chunks = await Promise.all(data.chunks.map(async (chunk) => (await get(chunk.url)).blob()));
  return { filename: data.filename || `ludoready-${projectId}.zip`, blob: new Blob(chunks, { type: 'application/zip' }) };
}
