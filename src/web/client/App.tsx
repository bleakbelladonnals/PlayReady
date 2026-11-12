import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { ArrowDownToLine, ArrowRight, Check, CircleAlert, ClipboardList, Clock3, Code2, Copy, Flag, Gamepad2, Home, Image, LoaderCircle, Maximize2, MonitorPlay, Plus, RotateCw, Sparkles } from 'lucide-react';
import '@fontsource/press-start-2p/latin-400.css';
import appIcon from './assets/playready-app-icon.webp';
import workshopScene from './assets/workshop-scene.webp';
import idleA from '../../renderer/assets/ludoready-packs/classic/frames/sprite-idle-a.png';
import idleB from '../../renderer/assets/ludoready-packs/classic/frames/sprite-idle-b.png';
import paintA from '../../renderer/assets/ludoready-packs/classic/frames/sprite-paint-a.png';
import paintB from '../../renderer/assets/ludoready-packs/classic/frames/sprite-paint-b.png';
import workA from '../../renderer/assets/ludoready-packs/classic/frames/sprite-work-a.png';
import workB from '../../renderer/assets/ludoready-packs/classic/frames/sprite-work-b.png';
import inspectA from '../../renderer/assets/ludoready-packs/classic/frames/sprite-inspect-a.png';
import inspectB from '../../renderer/assets/ludoready-packs/classic/frames/sprite-inspect-b.png';
import celebrateA from '../../renderer/assets/ludoready-packs/classic/frames/sprite-celebrate-a.png';
import celebrateB from '../../renderer/assets/ludoready-packs/classic/frames/sprite-celebrate-b.png';

type ProjectStatus = 'queued' | 'running' | 'complete' | 'failed';

type ProjectEvent = {
  time: string;
  stage: string;
  message: string;
  revision?: number;
};

export type ProductionRun = { url: string; id: string; revision: number };
type ProductionAttempt = { state: 'active' | 'done' | 'failed' | 'limited'; retryAt?: number };

type Project = {
  id: string;
  prompt: string;
  status: ProjectStatus;
  stage: string;
  error: string | null;
  events: ProjectEvent[];
  previewUrl: string | null;
  downloadUrl: string | null;
  revision: number;
  changePrompt: string | null;
  revisions: Array<{ revision: number; prompt: string; time: string; status: ProjectStatus }>;
  hasPublished: boolean;
  publishedRevision: number | null;
  run?: ProductionRun;
};

const POLL_INTERVAL_MS = 3000;
const MAX_PROMPT_LENGTH = 1000;

const STAGES = [
  { label: '准备制作', icon: ClipboardList, short: '想法就位', title: '准备搭建你的游戏世界', description: '从一个清楚的玩法开始，工坊会为它绘制画面、编写规则并准备试玩文件。', pose: [idleA, idleB], action: '准备开工' },
  { label: '规划游戏', icon: Sparkles, short: '玩法与画风', title: '正在规划玩法与画面', description: '确定目标、操作和挑战，整理背景、角色与互动素材的需求，让整个游戏保持统一风格。', pose: [idleA, idleB], action: '规划中' },
  { label: '绘制素材', icon: Image, short: '画面创作', title: '正在绘制游戏画面', description: '根据你的想法制作场景图片，让游戏世界有自己的样子。', pose: [paintA, paintB], action: '绘图中' },
  { label: '制作玩法', icon: Code2, short: '规则与操作', title: '正在把想法变成玩法', description: '制作操作、关卡与计分规则，加入开始、结束和重新挑战。', pose: [workA, workB], action: '制作中' },
  { label: '审查游戏', icon: Check, short: '玩法与素材', title: '正在审查制作结果', description: '核对玩法是否符合创意，检查素材是否正确使用、操作和反馈是否齐全。', pose: [inspectA, inspectB], action: '审查中' },
  { label: '试玩检查', icon: MonitorPlay, short: '运行与操作', title: '正在浏览器里检查游戏', description: '打开游戏并执行主要操作，检查运行错误、画面和开始、结束、重新挑战的流程。', pose: [inspectA, inspectB], action: '试玩中' },
  { label: '修复游戏', icon: RotateCw, short: '发现问题时', title: '正在修复发现的问题', description: '根据审查和试玩结果修正游戏，完成后会重新检查，通过后才交付。', pose: [workA, workB], action: '修复中' },
  { label: '制作完成', icon: Flag, short: '开玩与下载', title: '你的游戏已经准备好了', description: '切换到游戏试玩即可开始，也可以下载完整项目，留住这次创作。', pose: [celebrateA, celebrateB], action: '完成啦' },
] as const;

type ProductionProgress = Pick<Project, 'status' | 'stage' | 'events' | 'revision'>;
type StageProgressState = 'waiting' | 'active' | 'failed' | 'executed' | 'recheck' | 'unapproved' | 'passed' | 'skipped' | 'unrecorded';

function stageIndex(project: ProductionProgress | null): number {
  if (!project) return -1;
  if (project.status === 'complete') return STAGES.length - 1;
  const stages = [project.stage, ...currentEvents(project).map((event) => event.stage).reverse()];
  for (const stage of stages) {
    const index = STAGES.findIndex((item) => item.label === stage);
    if (index >= 0) return index;
    if (stage === '等待制作' || stage === '开始制作') return 0;
    if (stage === '检查游戏') return 5;
  }
  return 0;
}

function currentEvents(project: ProductionProgress): ProjectEvent[] {
  return project.events.filter((event) => (event.revision ?? 0) === (project.revision ?? 0));
}

export function getPipelineProgress(project: ProductionProgress | null): Array<{ state: StageProgressState; detail: string }> {
  const current = stageIndex(project);
  const events = project ? currentEvents(project) : [];
  const stages = events.map((event) => event.stage === '检查游戏' ? '试玩检查' : ['等待制作', '开始制作'].includes(event.stage) ? '准备制作' : event.stage);
  const lastRepair = stages.lastIndexOf('修复游戏');
  return STAGES.map((stage, index) => {
    const lastVisit = stages.lastIndexOf(stage.label);
    const gate = stage.label === '审查游戏' || stage.label === '试玩检查';
    if (index === current && project?.status !== 'complete') {
      return project?.status === 'failed'
        ? { state: 'failed', detail: gate ? '未通过验收' : '制作中断' }
        : { state: 'active', detail: project?.status === 'queued' ? '等待开始' : '进行中' };
    }
    if (project?.status === 'complete') {
      if (lastVisit >= 0 || index === current) return { state: 'passed', detail: gate ? '已通过' : '已完成' };
      return stage.label === '修复游戏' ? { state: 'skipped', detail: '无需修复' } : { state: 'unrecorded', detail: '未记录' };
    }
    if (lastVisit >= 0) {
      if (gate) {
        if (lastVisit < lastRepair) return { state: 'recheck', detail: '等待复查' };
        if (project?.status === 'failed') return { state: 'unapproved', detail: '未通过验收' };
        return { state: 'executed', detail: '已执行，待验收' };
      }
      return { state: 'executed', detail: '已执行' };
    }
    return { state: 'waiting', detail: stage.short };
  });
}

function Pipeline({ project }: { project: Project | null }) {
  const progress = getPipelineProgress(project);
  return (
    <ol className="pipeline" aria-label="游戏制作阶段">
      {STAGES.map((stage, index) => {
        const { state, detail } = progress[index]!;
        const active = state === 'active' || state === 'failed';
        const Icon = stage.icon;
        return <li key={stage.label} className={`is-${state} ${active ? 'is-active' : ''}`} aria-current={active ? 'step' : undefined}>
          <span className="stage-number">{state === 'passed' ? <Check size={12} /> : state === 'failed' || state === 'unapproved' ? <CircleAlert size={12} /> : state === 'recheck' ? <RotateCw size={12} /> : String(index + 1).padStart(2, '0')}</span>
          <Icon className="stage-icon" size={17} />
          <span><strong>{stage.label}</strong><small>{detail}</small></span>
          <span className="sr-only">{detail}</span>
        </li>;
      })}
    </ol>
  );
}

function Workshop({ project, landing = false }: { project: Project | null; landing?: boolean }) {
  const stage = STAGES[Math.max(0, stageIndex(project))]!;
  const failed = project?.status === 'failed';
  const queued = project?.status === 'queued';
  const title = landing ? '一个想法，一间创作工坊。' : failed ? '制作停在了这一步' : queued ? '你的想法已进入制作队列' : stage.title;
  const description = landing ? '写下你想玩的游戏。从规划、绘图、玩法制作到审查和试玩，都可以在这里看到进度。' : failed ? `${displayMessage(project.error || '制作过程中遇到了问题，请联系网站管理员。')}${project.hasPublished ? '上一次完成的游戏仍可试玩和下载，可以补充要求继续修改。' : '项目已保留，可以在“继续修改”中补充要求，接着完成这个游戏。'}` : queued ? '轮到这个项目时会自动开始。保留本页链接，可以稍后回来查看进度。' : stage.description;
  return <div className={`workshop ${failed ? 'is-paused' : ''}`}>
    <div className="workshop-scene">
      <img className="scene-art" src={workshopScene} alt="像素游戏工坊，设有创意桌、画架、电脑与关卡地图" />
      <span className="scene-sign"><span className="pixel-dot" /> PLAYREADY WORKSHOP</span>
      <div className={`workshop-character ${failed ? 'is-still' : ''}`} aria-hidden="true">
        <span className="character-bubble">{landing ? '有新想法吗？' : failed ? '暂时停工' : queued ? '等候开工' : stage.action}</span>
        <div className="character-frames" key={stage.action}><img src={stage.pose[0]} alt="" /><img src={stage.pose[1]} alt="" /></div>
        <span className="character-shadow" />
      </div>
      <span className="scene-label">2D GAME STUDIO</span>
    </div>
    <div className={`workshop-caption ${failed ? 'is-error' : ''}`} aria-live="polite">
      <span className="caption-icon">{failed ? <CircleAlert size={21} /> : project?.status === 'complete' ? <Flag size={21} /> : <stage.icon size={21} />}</span>
      <div><h2>{title}</h2><p>{description}</p></div>
      {project?.status === 'running' || queued ? <span className="live-indicator"><span /> 进度自动更新</span> : null}
    </div>
  </div>;
}

export function RevisionForm({ project, canPlay, changePrompt, revising, error, onChange, onSubmit }: {
  project: Pick<Project, 'status' | 'revision'>; canPlay: boolean; changePrompt: string; revising: boolean;
  error: string | null; onChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (project.status !== 'complete' && project.status !== 'failed') return null;
  return <form className="create-form revision-form" onSubmit={onSubmit}>
    <div className="section-heading"><RotateCw size={17} /><h2>继续修改</h2>{project.revision > 0 ? <span>已修改 {project.revision} 次</span> : null}</div>
    <div className="field-label-row"><label htmlFor="change-prompt">这次想改什么？</label><span>{changePrompt.length}/{MAX_PROMPT_LENGTH}</span></div>
    <textarea id="change-prompt" value={changePrompt} onChange={(event) => onChange(event.target.value)} placeholder={canPlay ? '例如：让角色移动更快，增加三条生命，统一金币和角色的画风。' : '说明希望保留的玩法，以及需要补充或调整的内容。'} required maxLength={MAX_PROMPT_LENGTH} rows={4} disabled={revising} />
    {error ? <p className="form-error" role="alert"><CircleAlert size={15} />{error}</p> : null}
    <button className="primary-button" type="submit" disabled={revising || !changePrompt.trim()}>{revising ? <><LoaderCircle className="spin" size={17} /> 正在提交</> : <>开始修改 <ArrowRight size={18} /></>}</button>
    <p className="form-note">保留当前项目和修改记录。每次修改使用一个制作名额，全站每天共 20 次。{canPlay ? '修改期间仍可试玩上次完成的版本。' : ''}</p>
  </form>;
}

function projectIdFromUrl(): string | null {
  const id = new URLSearchParams(window.location.search).get('project');
  return id && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : null;
}

function setProjectInUrl(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('project', id);
  window.history.replaceState(null, '', url);
}

function safeArtifactUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    return url.origin === window.location.origin && /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function responseError(response: Response): Promise<string> {
  let message = '';
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const error = (body as { error: unknown }).error;
      if (typeof error === 'string') message = error;
    }
  } catch {
    // A failed request may have no JSON body.
  }
  if (message) return displayMessage(message);
  if (response.status === 429) return '当前制作任务较多，请稍后再试。';
  if (response.status === 503) return '创作服务暂时不可用，请联系网站管理员。';
  if (response.status === 401 || response.status === 403) return '请求未获授权，请刷新页面或联系网站管理员。';
  if (response.status === 404) return '找不到这个项目，请检查页面链接。';
  return `请求失败（${response.status}），请稍后再试。`;
}

function displayMessage(value: string): string {
  return value.replace(/邀请人/gu, '网站管理员');
}

export async function requestProduction(run: ProductionRun | undefined, attempts: Map<string, ProductionAttempt>, retry = false): Promise<boolean> {
  if (!run) return false;
  const url = typeof run.url === 'string' ? safeArtifactUrl(run.url) : null;
  if (!url || typeof run.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(run.id) || !Number.isSafeInteger(run.revision) || run.revision < 0) {
    throw new Error('无法连接制作服务，请联系网站管理员。');
  }
  const key = `${run.id}:${run.revision}`;
  const previous = attempts.get(key);
  if (previous?.state === 'active' || previous?.state === 'done') return false;
  if (previous?.state === 'failed' && !retry) return false;
  if (previous?.state === 'limited' && Date.now() < previous.retryAt!) return false;
  // Claim before the first await: creation and queued polling may arrive together.
  attempts.set(key, { state: 'active' });
  try {
    const response = await fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Makers-Conversation-Id': run.id },
      body: JSON.stringify({ id: run.id, revision: run.revision }),
    });
    if (!response.ok) {
      if (response.status === 429) attempts.set(key, { state: 'limited', retryAt: Date.now() + 30_000 });
      throw new Error(await responseError(response));
    }
    if (!response.body) throw new Error('制作连接中断，请重新连接制作。');
    const reader = response.body.getReader();
    try {
      // Keep the production request alive; the job poll remains the source of progress.
      while (!(await reader.read()).done) { /* Consume all SSE bytes. */ }
    } finally {
      reader.releaseLock();
    }
    attempts.set(key, { state: 'done' });
    return true;
  } catch (error) {
    if (attempts.get(key)?.state !== 'limited') attempts.set(key, { state: 'failed' });
    throw error;
  }
}

function downloadFilename(value: string | undefined): string {
  return value?.replace(/[\\/\u0000-\u001f\u007f]/gu, '_').slice(0, 180) || 'ludoready-project.zip';
}

export async function fetchProjectDownload(value: string): Promise<{ blob: Blob; filename: string }> {
  const url = safeArtifactUrl(value);
  if (!url) throw new Error('下载地址不可用，请重新读取项目。');
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(await responseError(response));
  const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType === 'application/json') {
    const archive = await response.json() as { filename?: string; chunks?: Array<{ url: string; size: number }> };
    if (!archive || typeof archive.filename !== 'string' || !Array.isArray(archive.chunks) || !archive.chunks.length) {
      throw new Error('下载未完成，请重新下载。');
    }
    const parts: Blob[] = [];
    for (const chunk of archive.chunks) {
      const chunkUrl = chunk && typeof chunk.url === 'string' ? safeArtifactUrl(chunk.url) : null;
      if (!chunkUrl || !Number.isSafeInteger(chunk.size) || chunk.size < 0) throw new Error('下载未完成，请重新下载。');
      const part = await fetch(chunkUrl, { credentials: 'same-origin', cache: 'no-store' });
      if (!part.ok) throw new Error(await responseError(part));
      const blob = await part.blob();
      if (blob.size !== chunk.size) throw new Error('下载未完成，请重新下载。');
      parts.push(blob);
    }
    return { blob: new Blob(parts, { type: 'application/zip' }), filename: downloadFilename(archive.filename) };
  }
  if (!['application/zip', 'application/octet-stream', 'application/x-zip-compressed'].includes(contentType ?? '')) {
    throw new Error('下载暂时不可用，请稍后再试。');
  }
  const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/iu)?.[1];
  return { blob: await response.blob(), filename: downloadFilename(filename) };
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function App() {
  const [projectId, setProjectId] = useState<string | null>(projectIdFromUrl);
  const [project, setProject] = useState<Project | null>(null);
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [studioView, setStudioView] = useState<'preview' | 'workshop'>('preview');
  const [previewVersion, setPreviewVersion] = useState(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [changePrompt, setChangePrompt] = useState('');
  const [revising, setRevising] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [productionError, setProductionError] = useState<{ run: ProductionRun; message: string; retryAt?: number } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const eventListRef = useRef<HTMLOListElement>(null);
  const followEventsRef = useRef(true);
  const productionAttemptsRef = useRef(new Map<string, ProductionAttempt>());

  const kickProduction = useCallback((run: ProductionRun | undefined, retry = false) => {
    if (!run) return;
    const attempts = productionAttemptsRef.current;
    const pending = requestProduction(run, attempts, retry);
    if (attempts.get(`${run.id}:${run.revision}`)?.state === 'active') {
      setProductionError((previous) => previous?.run.id === run.id && previous.run.revision === run.revision ? null : previous);
    }
    void pending.catch((error: unknown) => {
      setProductionError({ run, message: error instanceof Error ? error.message : '制作连接中断，请重新连接制作。', retryAt: attempts.get(`${run.id}:${run.revision}`)?.retryAt });
    });
  }, []);

  useEffect(() => {
    const list = eventListRef.current;
    if (list && followEventsRef.current) list.scrollTop = list.scrollHeight;
  }, [project?.events.at(-1)?.time]);

  useEffect(() => {
    if (project?.publishedRevision !== null && project?.publishedRevision !== undefined) setStudioView('preview');
  }, [project?.publishedRevision]);

  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    let timeout: number | undefined;
    let controller: AbortController | undefined;

    async function poll() {
      controller = new AbortController();
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId!)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await responseError(response));
        const next = await response.json() as Project;
        if (disposed) return;
        setProject(next);
        setLoadError(null);
        if (next.status === 'queued') kickProduction(next.run);
        else setProductionError((previous) => previous?.run.id === next.id && previous.run.revision === next.revision ? null : previous);
        if (next.status === 'queued' || next.status === 'running') {
          timeout = window.setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (disposed || controller?.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : '连接中断，请重试。');
      }
    }

    void poll();
    return () => {
      disposed = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      controller?.abort();
    };
  }, [projectId, reloadKey, kickProduction]);

  const submit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmedPrompt }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { id?: unknown; run?: ProductionRun };
      if (typeof result.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.id)) {
        throw new Error('项目已提交，但没有收到有效的项目编号。请联系网站管理员确认。');
      }
      setProjectInUrl(result.id);
      setProjectId(result.id);
      setProject(null);
      setLoadError(null);
      kickProduction(result.run);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '提交失败，请稍后再试。');
    } finally {
      setSubmitting(false);
    }
  }, [prompt, submitting, kickProduction]);

  async function revise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || !changePrompt.trim() || revising) return;
    setRevising(true);
    setRevisionError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/revise`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: changePrompt.trim() }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { revision: number; run?: ProductionRun };
      setProject((previous) => previous ? { ...previous, status: 'queued', stage: '准备制作', error: null, revision: result.revision, run: result.run } : previous);
      setChangePrompt('');
      setStudioView('workshop');
      setReloadKey((value) => value + 1);
      kickProduction(result.run);
    } catch (error) {
      setRevisionError(error instanceof Error ? error.message : '修改要求提交失败，请稍后再试。');
    } finally { setRevising(false); }
  }

  async function copyProjectId() {
    if (!projectId) return;
    try {
      await navigator.clipboard.writeText(projectId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const previewUrl = safeArtifactUrl(project?.previewUrl ?? null);
  const downloadUrl = safeArtifactUrl(project?.downloadUrl ?? null);
  const currentProductionError = productionError?.run.id === projectId && (!project || project.status === 'queued' && project.revision === productionError.run.revision) ? productionError : null;
  const isWorking = project?.status === 'queued' || project?.status === 'running';
  const canPlay = Boolean(previewUrl);
  const statusLabel = !projectId ? '创作就绪' : !project ? '读取项目' : project.status === 'complete' ? '制作完成' : project.status === 'failed' ? '制作中断' : project.status === 'queued' ? '等待制作' : project.stage;

  async function downloadProject(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (!downloadUrl || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const archive = await fetchProjectDownload(downloadUrl);
      const url = URL.createObjectURL(archive.blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = archive.filename;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : '下载未完成，请重新下载。');
    } finally { setDownloading(false); }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await previewRef.current?.requestFullscreen();
      setPreviewError(null);
    } catch {
      setPreviewError('浏览器未能打开全屏，可以继续在当前区域试玩。');
    }
  }

  return (
    <div className="app-shell">
      <nav className="project-rail" aria-label="工坊导航">
        <a className="rail-brand" href="/" aria-label="PlayReady 首页"><img src={appIcon} alt="" /></a>
        <a className={`rail-action ${!projectId ? 'is-selected' : ''}`} href="/" aria-label="开始新的创作" title="开始新的创作"><Plus size={23} /></a>
        {projectId ? <span className="rail-project is-selected" title="当前游戏项目"><Gamepad2 size={22} /><span className={`rail-status ${project?.status ?? ''}`} /></span> : null}
      </nav>

      <div className="app-body">
        <header className="app-header">
          <a className="brand" href="/" aria-label="PlayReady 游戏创作工坊"><span className="brand-name">PlayReady</span><span className="brand-caption">游戏创作工坊</span></a>
          <div className="header-context"><span className="type-badge">2D WEB</span><span className={`status-badge ${project?.status ?? ''}`}><span />{statusLabel}</span></div>
          <a className="home-link" href="/" title="返回首页"><Home size={17} /><span>{projectId ? '新建游戏' : '创作首页'}</span></a>
        </header>

        <main className={`workbench ${projectId ? 'project-workbench' : 'home-workbench'}`}>
          <aside className="brief-column">
            {!projectId ? <>
              <div className="brief-heading"><span className="section-kicker">NEW PROJECT</span><h1>把你的想法<br />做成可玩的游戏。</h1><p>一个小世界，一套好玩的规则。<br />从你的一句话开始。</p></div>
              <form className="create-form" onSubmit={submit}>
                <div className="section-heading"><Sparkles size={17} /><h2>开始创作</h2><span>01</span></div>
                <div className="field-label-row"><label htmlFor="game-prompt">你的游戏想法</label><span>{prompt.length}/{MAX_PROMPT_LENGTH}</span></div>
                <textarea id="game-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：小狐狸在森林里收集发光蘑菇，避开猫头鹰。方向键移动，收集完成后抵达树屋。" required maxLength={MAX_PROMPT_LENGTH} rows={6} />
                <p className="prompt-hint">写下角色、目标和操作，会让玩法更清楚。</p>
                {submitError ? <p className="form-error" role="alert"><CircleAlert size={15} />{submitError}</p> : null}
                <button className="primary-button" type="submit" disabled={submitting || !prompt.trim()}>{submitting ? <><LoaderCircle className="spin" size={17} /> 正在创建项目</> : <>开始制作 <ArrowRight size={18} /></>}</button>
                <p className="form-note">写下想法即可创建游戏，完成后可试玩、下载和继续修改。</p>
              </form>
              <div className="creation-scope"><Gamepad2 size={18} /><div><strong>小型 2D 网页游戏</strong><span>直接在浏览器里运行</span></div></div>
            </> : <>
              <section className="creative-brief" aria-labelledby="brief-title">
                <span className="section-kicker">CREATIVE BRIEF</span>
                <div className="brief-title-row"><h1 id="brief-title">你的游戏创意</h1><span className="type-badge">WEB</span></div>
                <p>{project?.prompt || (loadError ? '项目信息尚未读取。' : '正在读取你的创意…')}</p>
                <div className="brief-meta"><Gamepad2 size={14} /><span>单人 · 小型 2D 游戏</span></div>
              </section>
              {project ? <RevisionForm project={project} canPlay={canPlay} changePrompt={changePrompt} revising={revising} error={revisionError} onChange={setChangePrompt} onSubmit={(event) => void revise(event)} /> : null}
              {isWorking && project?.revision ? <div className="revision-progress"><LoaderCircle className="spin" size={15} /><div><strong>正在进行第 {project.revision} 次修改</strong><p>{project.changePrompt}</p>{canPlay ? <span>上次完成的版本仍可试玩和下载。</span> : null}</div></div> : null}
              <section className="activity-panel" aria-labelledby="activity-heading">
                <div className="section-heading"><Clock3 size={17} /><h2 id="activity-heading">制作记录</h2><span>{project?.events.length ?? 0} 条</span></div>
                {project?.events.length ? <ol ref={eventListRef} className="event-list" tabIndex={0} aria-label="制作记录，向下滚动查看最新进度" onScroll={(event) => {
                  const list = event.currentTarget;
                  followEventsRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
                }}>{project.events.map((event, index) => <li className={`${index === project.events.length - 1 ? 'is-latest' : ''} ${event.stage === '制作中断' ? 'is-error' : ''}`} key={`${event.time}-${index}`}><span className="event-pin" /><div><div className="event-meta"><strong>{event.stage}</strong><time dateTime={event.time}>{formatEventTime(event.time)}</time></div><p>{displayMessage(event.message)}</p></div></li>)}</ol> : <p className="no-events">{loadError ? '连接恢复后即可查看制作记录。' : '项目信息读取后，制作记录会显示在这里。'}</p>}
                {isWorking && !loadError ? <div className="update-note"><span className="live-dot" /> 制作记录自动更新</div> : null}
              </section>
              <div className="project-reference"><span>项目编号</span><button type="button" onClick={() => void copyProjectId()} aria-label="复制项目编号" title={projectId}><span>{projectId}</span>{copied ? <Check size={14} /> : <Copy size={14} />}</button><span className="copy-feedback" aria-live="polite">{copied ? '已复制项目编号' : '保留本页链接，可回到项目查看进度。'}</span></div>
            </>}
          </aside>

          <section className="studio-column" aria-label="游戏制作工作台">
            <div className="studio-heading"><div><span className="section-kicker">PRODUCTION STUDIO</span><h2>{projectId ? '游戏制作工作台' : '你的游戏，从这里诞生'}</h2></div><span className="studio-mode"><span className="pixel-dot" /> {!projectId ? '创作工坊' : isWorking ? project?.revision ? '修改中' : '制作中' : project?.status === 'failed' ? '已中断' : canPlay ? '已交付' : '连接中'}</span></div>
            <Pipeline project={project} />
            {loadError ? <div className="connection-error" role="alert"><CircleAlert size={18} /><span>{loadError}</span><button type="button" onClick={() => setReloadKey((value) => value + 1)}><RotateCw size={14} /> 重新连接</button></div> : null}
            {currentProductionError ? <div className="connection-error" role="alert"><CircleAlert size={18} /><span>{currentProductionError.message}</span><button type="button" disabled={Boolean(currentProductionError.retryAt && Date.now() < currentProductionError.retryAt)} onClick={() => kickProduction(currentProductionError.run, true)}><RotateCw size={14} /> 重新连接制作</button></div> : null}
            <div className="studio-panel">
              <div className="studio-toolbar">
                {canPlay ? <div className="view-tabs" role="tablist" aria-label="工作台视图" onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const view = event.key === 'Home' ? 'preview' : event.key === 'End' ? 'workshop' : studioView === 'preview' ? 'workshop' : 'preview';
                  setStudioView(view);
                  document.getElementById(`${view}-tab`)?.focus();
                }}><button id="preview-tab" type="button" role="tab" tabIndex={studioView === 'preview' ? 0 : -1} aria-selected={studioView === 'preview'} aria-controls="preview-panel" onClick={() => setStudioView('preview')}><MonitorPlay size={17} /> 游戏试玩</button><button id="workshop-tab" type="button" role="tab" tabIndex={studioView === 'workshop' ? 0 : -1} aria-selected={studioView === 'workshop'} aria-controls="workshop-panel" onClick={() => setStudioView('workshop')}><Sparkles size={16} /> 制作工坊</button></div> : <span className="toolbar-title"><Sparkles size={16} /> 制作工坊</span>}
                <div className="toolbar-actions">
                  {canPlay && studioView === 'preview' ? <><button type="button" className="icon-button" aria-label="重新加载游戏" title="重新加载游戏" onClick={() => setPreviewVersion((value) => value + 1)}><RotateCw size={16} /></button>{document.fullscreenEnabled ? <button type="button" className="icon-button" aria-label="全屏试玩" title="全屏试玩" onClick={() => void toggleFullscreen()}><Maximize2 size={16} /></button> : null}</> : null}
                  {downloadUrl ? <a className="download-button" href={downloadUrl} download aria-busy={downloading} aria-disabled={downloading} onClick={(event) => void downloadProject(event)}>{downloading ? <LoaderCircle className="spin" size={15} /> : <ArrowDownToLine size={15} />}<span>{downloading ? '正在准备下载' : '下载项目'}</span></a> : <span className="toolbar-note"><Gamepad2 size={15} /> 小型 2D 游戏</span>}
                </div>
              </div>
              {downloadError ? <p className="preview-error" role="alert">{downloadError}</p> : null}
              {canPlay ? <div id="preview-panel" role="tabpanel" aria-labelledby="preview-tab" hidden={studioView !== 'preview'}>{project?.status !== 'complete' ? <p className="previous-version-note">{isWorking ? '新版本正在制作，当前可试玩上次完成的版本。' : '这次修改未完成，当前保留上次完成的版本。'}</p> : null}<div className="game-frame" ref={previewRef}><iframe key={`${project?.publishedRevision ?? 0}-${previewVersion}`} title="你的游戏预览" src={previewUrl!} sandbox="allow-scripts allow-pointer-lock allow-downloads" allow="fullscreen" /></div><div className="preview-caption"><span><span className="live-dot" /> {project?.status === 'complete' ? '游戏已就绪' : '上次完成的版本'}</span><p>点击游戏区域后，即可使用键盘操作。</p></div>{previewError ? <p className="preview-error" role="alert">{previewError}</p> : null}</div> : null}
              <div id="workshop-panel" role={canPlay ? 'tabpanel' : undefined} aria-labelledby={canPlay ? 'workshop-tab' : undefined} hidden={canPlay && studioView !== 'workshop'}>
                {!projectId || project ? <Workshop project={project} landing={!projectId} /> : <div className="unavailable-panel">{loadError ? <CircleAlert size={30} /> : <LoaderCircle className="spin" size={30} />}<h2>{loadError ? '暂时无法读取这个项目' : '正在读取你的项目'}</h2><p>{loadError ? '请在创建项目的原浏览器中打开此链接，或重新连接。' : '读取完成后，这里会显示工坊与制作进度。'}</p></div>}
              </div>
            </div>
            <div className="studio-footnote"><span><MonitorPlay size={12} /> 电脑浏览器创作</span><span>{projectId ? '规划 → 制作 → 审查 → 试玩 → 交付' : '描述想法，等待制作，开玩。'}</span></div>
          </section>
        </main>
        <footer className="app-footer"><span>PlayReady</span><span>把想法做成好玩的东西</span></footer>
      </div>
    </div>
  );
}

export default App;
