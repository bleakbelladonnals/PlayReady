import { copyFile, readFile, readlink, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../dist/main/projectStore.js';
import { EventLog } from '../dist/main/eventLog.js';
import { AssetStore } from '../dist/main/assetStore.js';
import { preparePelicanProject } from './prepare-pelican-project.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argument = process.argv.indexOf('--user-data');
if (argument < 0 || !process.argv[argument + 1]) {
  throw new Error('请先退出本地 LudoReady，再指定 --user-data <现有用户数据目录>。');
}
const userData = resolve(process.argv[argument + 1]);
const storageFile = join(userData, 'projects.json');
const original = JSON.parse(await readFile(storageFile, 'utf8'));

// Mutate through ProjectStore only while its owning Electron process is stopped.
let lock;
try { lock = await readlink(join(userData, 'SingletonLock')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (lock) {
  const pid = Number(/-(\d+)$/u.exec(lock)?.[1]);
  if (pid) {
    try {
      process.kill(pid, 0);
      throw new Error('本地 LudoReady 仍在运行，请退出后再导入，以免覆盖内存中的项目目录。');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

const store = new ProjectStore(storageFile, original.settings.defaultWorkspace);
const events = new EventLog(join(userData, 'events'));
const assets = new AssetStore();
await store.init();
await events.init();
const journalPath = join(userData, 'pelican-project-imports.json');
let journal = { version: 1, projects: {} };
try { journal = JSON.parse(await readFile(journalPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (journal.version !== 1 || !journal.projects) throw new Error('不支持的鹈鹕项目导入记录。');

async function saveJournal() {
  const temporary = `${journalPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, journalPath);
}

function runNpm(cwd, args) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd, stdio: 'inherit', timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} 未完成。`);
}

const definitions = [
  {
    id: 'astra', name: '鹈鹕骑车 · Astra', model: 'GPT-6 Astra',
    source: 'https://github.com/toankhontech/pelican-rider',
    idea: '海岸漫游：保留 GPT-6 Astra 原作的微缩海岸与摄影棚、三种光照、骑行节奏及镜头环绕，在 LudoReady 中继续完善角色动作、场景与交互。',
  },
  {
    id: 'opus', name: '鹈鹕骑车 · Opus 5.5', model: 'Claude Opus 5.5',
    source: 'https://github.com/riba2534/claude-opus-5-5-demo/tree/main/pelican-bike',
    idea: '追风骑行：保留 Claude Opus 5.5 原作的海岸骑行、变道抓鱼、跳跃特技、多种镜头、声音和昼夜，在 LudoReady 中继续完善反馈与玩法。',
  },
];

const imported = [];
for (const definition of definitions) {
  // Once imported, renamed, edited or deleted projects are never recreated by a rerun.
  if (journal.projects[definition.id]) {
    process.stdout.write(`${definition.name} 已有导入记录，保留当前项目状态。\n`);
    continue;
  }
  let project = await store.create({
    name: definition.name, idea: definition.idea, engine: 'web', model: null,
    parentDirectory: (await store.getSettings()).defaultWorkspace,
  });
  journal.projects[definition.id] = { projectId: project.id, root: project.root, state: 'preparing' };
  await saveJournal();
  async function record(kind, title, message, stage, method) {
    await events.append({ id: randomUUID(), projectId: project.id, kind, title, message, stage, method, timestamp: new Date().toISOString() });
  }
  try {
    const prepared = await preparePelicanProject({ sourceId: definition.id, projectRoot: project.root, appRoot, projectId: project.id });
    await record('assistant', `原作来源 · ${definition.model}`, `${definition.idea}\n\n来源：${definition.source}\n原作者模型记录及许可已保存在项目来源文件中。`, 'brief', 'project/source-imported');
    const [cover] = await assets.importFiles(project.id, project.root, [prepared.coverPath]);
    await copyFile(prepared.coverPath, join(project.root, '.ludoready/icon.png'));
    await record('file', '源码与素材已接入', '场景、角色、骑行动作与交互源码已放入独立工程。场景封面已加入素材库，可在右侧「素材」查看；代码与来源文件可在「文件」查看。', 'assets', 'project/files-imported');
    runNpm(project.root, ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
    runNpm(project.root, ['run', 'build']);
    if (!(await stat(join(project.root, 'dist/index.html'))).isFile()) throw new Error('构建缺少 dist/index.html');
    await record('lifecycle', '项目构建完成', '已从本项目源码构建 dist/index.html，依赖随运行包保存在本地。右侧预览、素材与文件使用 LudoReady 现有项目工作台。', 'verify', 'project/build-completed');
    project = await store.update(project.id, {
      status: 'completed', stage: 'complete',
      icon: { path: '.ludoready/icon.png', source: 'procedural', updatedAt: new Date().toISOString() },
    });
    await record('assistant', '可以继续修改', `${prepared.summary.features}\n\n操作：${prepared.summary.controls}\n\n在下方输入想调整的画面或玩法，即可让当前选择的模型继续修改这个项目。`, 'complete', 'project/import-completed');
    journal.projects[definition.id].state = 'completed';
    await saveJournal();
    imported.push({ id: project.id, name: project.name, root: project.root, cover: cover.relativePath });
  } catch (error) {
    await store.update(project.id, { status: 'failed', lastError: error.message });
    journal.projects[definition.id].state = 'failed';
    await saveJournal();
    throw error;
  }
}
await events.flush();
const after = await store.list();
for (const existing of original.projects) {
  const preserved = after.find(project => project.id === existing.id);
  if (!preserved || preserved.root !== existing.root || preserved.updatedAt !== existing.updatedAt) {
    throw new Error(`原有项目记录校验失败：${existing.id}`);
  }
}
process.stdout.write(`${JSON.stringify({ imported, projectCount: after.length, existingProjectsPreserved: original.projects.length }, null, 2)}\n`);
