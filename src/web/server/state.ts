import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type JobStatus = 'queued' | 'running' | 'complete' | 'failed';
export interface JobEvent { time: string; stage: string; message: string; revision?: number }
export interface JobRevision { revision: number; prompt: string; time: string; status: JobStatus }
export interface Job {
  id: string;
  prompt: string;
  status: JobStatus;
  stage: string;
  error: string | null;
  events: JobEvent[];
  createdAt: string;
  sessionHash: string;
  previewToken: string;
  revision?: number;
  changePrompt?: string | null;
  revisions?: JobRevision[];
  hasPublished?: boolean;
  publishedRevision?: number | null;
  draftSourceKey?: string;
}
interface State { version: 1; jobs: Job[] }

const MAX_DAILY_JOBS = 20;
const MAX_PROMPT_LENGTH = 1000;
const MAX_EVENTS = 60;

export class WebState {
  private state: State = { version: 1, jobs: [] };
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as State;
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
        throw new Error('Invalid Web state file');
      }
      this.state = { version: 1, jobs: parsed.jobs };
      for (const job of this.state.jobs) {
        job.revision ??= 0;
        job.changePrompt ??= null;
        job.revisions ??= [];
        job.hasPublished ??= job.status === 'complete';
        job.publishedRevision ??= job.hasPublished ? 0 : null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.write();
    }
    const interrupted = this.state.jobs.filter((job) => job.status === 'queued' || job.status === 'running');
    for (const job of interrupted) {
      job.status = 'failed';
      job.stage = '制作中断';
      job.error = '服务重启打断了制作。请稍后继续修改，或联系网站管理员并提供项目编号。';
      job.events.push({ time: new Date().toISOString(), stage: job.stage, message: job.error, revision: job.revision });
      const revision = job.revisions?.find((item) => item.revision === job.revision);
      if (revision) revision.status = 'failed';
    }
    if (interrupted.length) await this.write();
  }

  async create(rawPrompt: unknown): Promise<{ job: Job; session: string }> {
    const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      throw new WebInputError(400, `请填写 1–${MAX_PROMPT_LENGTH} 字的游戏想法。`);
    }
    return this.mutate(async () => {
      this.checkDailyBudget();
      const session = randomBytes(32).toString('base64url');
      const now = new Date().toISOString();
      const job: Job = {
        id: randomUUID(), prompt, status: 'queued', stage: '准备制作', error: null,
        events: [{ time: now, stage: '准备制作', message: '项目已创建，正在等待制作。', revision: 0 }],
        createdAt: now, sessionHash: hash(session), previewToken: randomBytes(32).toString('base64url'),
        revision: 0, changePrompt: null, revisions: [], hasPublished: false, publishedRevision: null,
      };
      this.state.jobs.push(job);
      return { job: structuredClone(job), session };
    });
  }

  get(id: string): Job | null {
    const job = this.state.jobs.find((item) => item.id === id);
    return job ? structuredClone(job) : null;
  }

  authorized(id: string, session: string | undefined): Job | null {
    const job = this.get(id);
    return job && session && hash(session) === job.sessionHash ? job : null;
  }

  async revise(id: string, session: string | undefined, rawPrompt: unknown): Promise<Job> {
    const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      throw new WebInputError(400, `请填写 1–${MAX_PROMPT_LENGTH} 字的修改要求。`);
    }
    return this.mutate(async () => {
      const job = this.state.jobs.find((item) => item.id === id);
      if (!job || !session || hash(session) !== job.sessionHash) throw new WebInputError(404, '找不到这个项目，请在原浏览器中打开。');
      if (job.status === 'queued' || job.status === 'running') throw new WebInputError(409, '这个项目正在制作，请等待当前制作结束。');
      this.checkDailyBudget();
      const time = new Date().toISOString();
      job.revision = (job.revision ?? 0) + 1;
      job.changePrompt = prompt;
      job.revisions ??= [];
      job.revisions.push({ revision: job.revision, prompt, time, status: 'queued' });
      job.status = 'queued';
      job.stage = '准备制作';
      job.error = null;
      job.events.push({ time, stage: job.stage, message: `已收到第 ${job.revision} 次修改：${prompt}`, revision: job.revision });
      if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
      return structuredClone(job);
    });
  }

  preview(id: string, token: string): Job | null {
    const job = this.get(id);
    return job?.hasPublished && token === job.previewToken ? job : null;
  }

  async update(id: string, status: JobStatus, stage: string, message: string, error: string | null = null): Promise<void> {
    await this.mutate(async () => {
      const job = this.state.jobs.find((item) => item.id === id);
      if (!job) throw new Error('Unknown job');
      job.status = status;
      job.stage = stage;
      job.error = error;
      job.events.push({ time: new Date().toISOString(), stage, message, revision: job.revision ?? 0 });
      const revision = job.revisions?.find((item) => item.revision === job.revision);
      if (revision) revision.status = status;
      if (status === 'complete') {
        job.hasPublished = true;
        job.publishedRevision = job.revision ?? 0;
      }
      if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    });
  }

  private checkDailyBudget(): void {
    const today = chinaDay(new Date());
    const count = this.state.jobs.reduce((sum, job) => sum
      + Number(chinaDay(new Date(job.createdAt)) === today)
      + (job.revisions ?? []).filter((revision) => chinaDay(new Date(revision.time)) === today).length, 0);
    if (count >= MAX_DAILY_JOBS) throw new WebInputError(429, '今天的制作名额已满，请明天再试。每次修改也会使用一个制作名额。');
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const result = await operation();
      await this.write();
      return result;
    } finally { release(); }
  }

  private async write(): Promise<void> {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temp, this.file);
  }
}

export class WebInputError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function chinaDay(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}
