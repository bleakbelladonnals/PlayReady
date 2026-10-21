import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const WORKS = {
  astra: {
    name: '鹈鹕骑车 · 海岸漫游',
    model: 'GPT-6 Astra',
    repository: 'https://github.com/toankhontech/pelican-rider',
    commit: 'e40244c8a7d78bee47ceb2819b2d02b04226474d',
    records: ['LICENSE', 'PROVENANCE.json', 'SOURCE.md', 'README.md', 'DESIGN.md', 'QA.md'],
    features: '海岸与摄影棚、三种光线、两档骑行速度、镜头拖动与自动环绕。',
    controls: '拖动旋转镜头，滚轮缩放；C 切换场景，P / 空格 / Esc 暂停或继续，R 重新开始。光线、速度与自动环绕使用画面底部按钮。无音频。',
  },
  opus: {
    name: '鹈鹕骑车 · 追风骑行',
    model: 'Claude Opus 5.5',
    repository: 'https://github.com/riba2534/claude-opus-5-5-demo',
    commit: '54adc1fb64155f9dd7c1c90ecae7b8185ac540b8',
    records: ['SOURCE.md', 'THIRD_PARTY_NOTICES.txt', 'UPSTREAM-README.md', 'package.json', 'package-lock.json'],
    features: '沿海骑行、变道抓鱼、跳跃与展翅特技、五种镜头、实时昼夜、车铃与合成音频。',
    controls: 'W / S 加速刹车，A / D 变道，空格跳跃，T 特技，B 车铃，H 鸣叫，C 切换镜头，Q / E 换挡，N 时间快进，P / Esc 暂停或继续，M 声音，R 重新开始，U 隐藏界面。鼠标拖拽和滚轮控制自由镜头。',
  },
};

/** Prepares a newly created ProjectStore workspace; never touches the catalog or event log. */
export async function preparePelicanProject({ sourceId, projectRoot, appRoot, projectId }) {
  const work = WORKS[sourceId];
  if (!work) throw new Error(`Unknown pelican source: ${sourceId}`);
  const root = resolve(projectRoot);
  const source = join(resolve(appRoot), 'src', 'showcases', sourceId);
  const metadata = JSON.parse(await readFile(join(root, '.ludoready', 'project.json'), 'utf8'));
  if (metadata.id !== projectId) throw new Error('New workspace identity does not match projectId');

  // This helper is only called for a newly created workspace. Remove its neutral starter sources.
  await rm(join(root, 'src'), { recursive: true, force: true });
  await cp(join(source, 'src'), join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'sources'), { recursive: true });
  for (const filename of work.records) {
    await cp(join(source, filename), join(root, 'sources', filename));
  }
  await cp(join(source, 'cover.png'), join(root, 'sources', 'cover.png'));
  await writeFile(join(root, 'sources', 'README.sources.md'),
    '# 来源档案\n\n此目录保留引入时已有的来源、许可与历史说明。这里的 README、QA 和适配记录描述对应版本，不作为当前项目的构建或试玩结果。当前操作与构建方式见项目根目录 README.md。\n');
  if (sourceId === 'astra') await cp(join(source, 'LICENSE'), join(root, 'LICENSE'));
  else await cp(join(source, 'THIRD_PARTY_NOTICES.txt'), join(root, 'THIRD_PARTY_NOTICES.txt'));

  let main = await readFile(join(root, 'src', 'main.js'), 'utf8');
  let template = await readFile(join(source, sourceId === 'astra' ? 'index.html' : 'index.template.html'), 'utf8');
  if (sourceId === 'astra') {
    ({ main, template } = adaptAstra(main, template));
    await writeFile(join(root, 'src', 'style.css'), `${await readFile(join(root, 'src', 'style.css'), 'utf8')}\n${ASTRA_STYLE}`);
  } else {
    ({ main, template } = adaptOpus(main, template));
  }
  await writeFile(join(root, 'src', 'main.js'), main);
  await writeFile(join(root, 'index.template.html'), template);
  // The source template is not a browser entrypoint; production preview always uses dist/index.html.
  await rm(join(root, 'index.html'), { force: true });
  await writeFile(join(root, 'build.mjs'), BUILD_SCRIPT);
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: `pelican-${sourceId}`,
    version: '1.0.0',
    private: true,
    type: 'module',
    description: work.name,
    scripts: { build: 'node build.mjs' },
    dependencies: { three: '0.185.1' },
    devDependencies: { esbuild: '0.28.2' },
  }, null, 2)}\n`);
  await writeFile(join(root, 'README.md'), readme(work));
  await writeFile(join(root, 'GAME_DESIGN.md'), gameDesign(work, sourceId));
  await writeFile(join(root, 'SOURCE.md'), `# ${work.name} · 来源\n\n- 上游仓库：${work.repository}\n- 固定提交：${work.commit}\n- 上游模型归属：${work.model}，详见 sources/ 中保留的原始记录。\n- 当前项目保留程序化场景与主要交互，补充独立项目控制、中文说明和本地构建入口。\n- ${sourceId === 'astra' ? '应用源码许可见 LICENSE。' : '上游 package.json 声明 ISC；其原始声明保存在 sources/package.json，上游未附独立 LICENSE 正文。'}\n- Three.js 0.185.1 的许可由构建脚本复制至 dist/THREE-LICENSE.txt。\n\n## 本项目操作调整\n\nEsc / P 在画面内暂停或继续；R 和“重新开始”按钮只重置当前游戏。操作直接作用于本项目，不依赖独立展示弹窗。${sourceId === 'opus' ? '声音默认关闭；M 或声音按钮控制实际音频状态。' : 'C 切换海岸与摄影棚。'}\n\n历史 QA 和原适配过程保留在 sources/，当前 LudoReady 试玩记录由宿主单独保存。\n`);
  await writeFile(join(root, '.ludoready', 'playtest.json'), `${JSON.stringify(playtest(sourceId), null, 2)}\n`);
  return {
    coverPath: join(root, 'sources', 'cover.png'),
    summary: { name: work.name, model: work.model, repository: work.repository, commit: work.commit, controls: work.controls, features: work.features },
  };
}

function replaceRequired(source, before, after) {
  if (!source.includes(before)) throw new Error(`Pelican source changed; missing adapter target: ${before.slice(0, 80)}`);
  return source.replace(before, after);
}

function adaptAstra(main, template) {
  template = replaceRequired(template, 'Esc 返回', 'P 暂停 · C 场景 · R 重来');
  template = replaceRequired(template, '<h1>鹈鹕骑车</h1>', '<h1>海岸漫游</h1>');
  template = replaceRequired(template, '<span>暂停</span></button></div>', '<span>暂停</span></button><button id="restart" aria-label="重新开始骑行" title="重新开始 (R)">重来</button></div>');
  main = replaceRequired(main, "window.parent.postMessage({ type: 'ludoready-showcase-close' }, '*');", 'if (!event.repeat) togglePause();');
  main = replaceRequired(main,
    "  } else if (event.code === 'Space' && !event.target.closest('button, input, select, textarea')) {",
    "  } else if (event.code === 'KeyP' && !event.repeat) {\n    event.preventDefault();\n    togglePause();\n  } else if (event.code === 'KeyR' && !event.repeat) {\n    event.preventDefault();\n    location.reload();\n  } else if (event.code === 'KeyC' && !event.repeat) {\n    event.preventDefault();\n    document.getElementById(mode === 'coast' ? 'studio' : 'coast').click();\n  } else if (event.code === 'Space' && !event.repeat && !event.target.closest('button, input, select, textarea')) {");
  main += "\ndocument.getElementById('restart').onclick = () => location.reload();\n";
  return { main, template };
}

function adaptOpus(main, template) {
  main = replaceRequired(main, "    parent.postMessage({ type: 'ludoready-showcase-close' }, '*');", '    if (!e.repeat) setPaused(!S.paused);');
  main = replaceRequired(main, 'function setPaused(paused) {\n  S.paused = paused;', 'function setPaused(paused) {\n  S.paused = paused;\n  updateProjectControls();');
  main = replaceRequired(main, 'function setMuted(muted) {\n  showcase.muted = muted;', 'function setMuted(muted) {\n  showcase.muted = muted;\n  updateProjectControls();');
  main = replaceRequired(main, "    case 'KeyM':", "    case 'KeyR':\n      e.preventDefault();\n      location.reload();\n      break;\n    case 'KeyM':");
  main += `
// Workbench controls act on the same state as the keyboard and scene.
function updateProjectControls() {
  const pauseButton = document.getElementById('project-pause');
  pauseButton.textContent = S.paused ? '继续' : '暂停';
  pauseButton.setAttribute('aria-label', S.paused ? '继续骑行' : '暂停骑行');
  pauseButton.setAttribute('aria-pressed', String(S.paused));
  const soundButton = document.getElementById('project-sound');
  soundButton.textContent = showcase.muted ? '开声' : '静音';
  soundButton.setAttribute('aria-label', showcase.muted ? '开启声音' : '关闭声音');
  soundButton.setAttribute('aria-pressed', String(!showcase.muted));
}
document.getElementById('project-pause').onclick = () => setPaused(!S.paused);
document.getElementById('project-sound').onclick = () => setMuted(!showcase.muted);
document.getElementById('project-restart').onclick = () => location.reload();
updateProjectControls();
`;
  template = replaceRequired(template, '<div class="tools panel">', `<div class="project-title">追风骑行 <small>Claude Opus 5.5</small></div>\n  <div class="tools panel">
    <button class="project-control" id="project-pause" aria-label="暂停骑行" title="暂停或继续 (P / Esc)" aria-pressed="false">暂停</button>
    <button class="project-control" id="project-sound" aria-label="开启声音" title="声音 (M)" aria-pressed="false">开声</button>
    <button class="project-control" id="project-restart" aria-label="重新开始骑行" title="重新开始 (R)">重来</button>`);
  template = replaceRequired(template, '<kbd>Esc</kbd> 返回工作台', '<kbd>Esc</kbd> 暂停或继续');
  template = replaceRequired(template, '<li><kbd>U</kbd> 隐藏界面</li><li><kbd>P</kbd> 暂停</li>', '<li><kbd>U</kbd> 隐藏界面</li><li><kbd>P</kbd> 暂停或继续</li><li><kbd>R</kbd> 重新开始</li>');
  template = replaceRequired(template, '<span><kbd>U</kbd> 隐藏界面</span>', '<span><kbd>P</kbd> 暂停</span><span><kbd>M</kbd> 声音</span><span><kbd>R</kbd> 重来</span>');
  template = replaceRequired(template, '</style>', `${OPUS_STYLE}\n</style>`);
  return { main, template };
}

const ASTRA_STYLE = `
@media (min-width: 561px) and (max-width: 820px) {
  #stage { bottom: 142px; }
  .controls { display: grid; grid-template-columns: 1fr 1.35fr; gap: 8px 14px; max-width: 500px; }
  .scene-note, .hint { bottom: 154px; }
}
`;

const OPUS_STYLE = `
.project-title { position:absolute; top:21px; left:18px; color:#edf7fc; font-size:14px; font-weight:700; text-shadow:0 1px 4px #22384d; }
.project-title small { margin-left:7px; font-size:10px; font-weight:400; }
.tools { top:12px; right:12px; gap:3px; }
.project-control { pointer-events:auto; cursor:pointer; border:0; padding:0 9px; height:36px; background:transparent; color:inherit; font:inherit; font-size:12px; border-radius:6px; }
.project-control:hover, .project-control[aria-pressed="true"] { background:#ffffff25; }
.cams { top:63px; left:50%; right:auto; transform:translateX(-50%); }
@media (max-width:900px) { .cams { top:63px; left:12px; right:12px; transform:none; justify-content:center; } }
@media (max-width:560px) { .project-title { top:16px; left:12px; font-size:12px; max-width:90px; } .project-title small { display:none; } .tools { gap:0; padding:3px; } .project-control { padding:0 6px; } .tools .icon-btn { width:30px; } .cams { top:58px; } }
`;

const BUILD_SCRIPT = String.raw`import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.js'],
  outfile: 'app.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  legalComments: 'eof',
});
const js = result.outputFiles.find((file) => file.path.endsWith('.js')).text
  .replace(new RegExp('</script', 'giu'), (match) => '<' + String.fromCharCode(92) + '/' + match.slice(2));
const css = (result.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '')
  .replace(new RegExp('</style', 'giu'), (match) => '<' + String.fromCharCode(92) + '/' + match.slice(2));
const template = await readFile(join(root, 'index.template.html'), 'utf8');
const html = template
  .replace('<!--OG_IMAGE-->', '')
  .replace('<link rel="stylesheet" href="./showcase.css">', () => '<style>' + css + '</style>')
  .replace('<script defer src="./showcase.js"></script>', () => '<script>' + js + '</script>')
  .replace('/*APP_JS*/', () => js);
await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist', 'index.html'), html);
await cp(join(root, 'public', 'assets'), join(root, 'dist', 'assets'), { recursive: true });
await cp(join(root, 'node_modules', 'three', 'LICENSE'), join(root, 'dist', 'THREE-LICENSE.txt'));
console.log('Built dist/index.html with local scripts, styles, and assets.');
`;

function readme(work) {
  return `# ${work.name}\n\n${work.features}\n\n## 操作\n\n${work.controls}\n\n进入后自动骑行。重新开始会重置本次骑行与画面设置，不会离开 LudoReady 工作台。\n\n## 修改与构建\n\n代码位于 src/，界面位于 index.template.html。\n\n\`\`\`sh\nnpm install --ignore-scripts\nnpm run build\n\`\`\`\n\n构建入口 build.mjs 将脚本、Three.js 与样式放入 dist/index.html；程序化场景无需外部贴图或联网资源。public/assets/ 中的素材同步到 dist/assets/。在 LudoReady 中刷新项目预览即可读取新构建。\n\n.ludoready/playtest.json 定义当前实际操作路线。试玩结果与截图由 LudoReady 宿主产生，不由构建脚本生成。\n\n## 来源\n\n上游作品归属 ${work.model}，来源 ${work.repository}，固定提交 ${work.commit}。项目保留源码与许可，当前使用方式见此文档；引入时已有的历史说明单独保存在 sources/。\n`;
}

function gameDesign(work, sourceId) {
  return `# ${work.name}\n\n## 核心体验\n\n${work.features}\n\n${sourceId === 'astra' ? '观察鹈鹕踩踏、自行车轮转和场景光线之间的联系；在海岸与摄影棚切换，拖动镜头查看动作与结构，调整速度后继续观察。' : '沿海骑行时控制速度与方向，变道抓鱼、跳跃和做特技；骑行中持续积累里程、鱼与成就，切换视角与时刻。'}\n\n## 操作\n\n${work.controls}\n\n## 暂停与重来\n\n暂停冻结骑行，按钮文字切换为“继续”；恢复后接着当前进度骑行。重来恢复初始场景与骑行状态。${sourceId === 'astra' ? '暂停后仍可手动调整场景与镜头。' : '声音默认关闭，通过 M 或声音按钮开启；暂停同时静音，恢复遵循声音设置。'}\n\n## 验收路线\n\n打开画面并确认场景可见，${sourceId === 'astra' ? '拖动镜头，切换摄影棚，再暂停、恢复并重回海岸。' : '加速、变道和跳跃，再暂停、恢复并重新开始。'}具体输入和可观察状态位于 .ludoready/playtest.json；已运行的试玩证据由宿主记录。\n\n## 源码\n\nsrc/ 保存生产源码，index.template.html 保存界面，npm run build 输出 dist/index.html。程序化三维造型位于源码，不依赖额外模型下载。\n`;
}

function playtest(sourceId) {
  const astra = sourceId === 'astra';
  const key = (code, holdMs = 60) => ({ type: 'key', code, holdMs });
  const wait = (ms) => ({ type: 'wait', ms });
  const move = astra
    ? [{ type: 'drag', fromXRatio: 0.68, fromYRatio: 0.52, toXRatio: 0.3, toYRatio: 0.42, button: 0, durationMs: 500 }, wait(500)]
    : [key('KeyA', 700), wait(200)];
  const actions = {
    start: { inputs: astra ? [wait(800)] : [key('KeyW', 900)] },
    move: { inputs: move },
    primary: { inputs: astra ? [key('KeyC'), wait(1600)] : [key('Space'), wait(100)] },
    pause: { inputs: [key('KeyP'), wait(350)] },
    restart: { inputs: [key('KeyR'), wait(1400)] },
  };
  const visible = (value, description) => ({ kind: 'text-visible', value, description });
  const rendered = { kind: 'canvas-not-blank', description: '鹈鹕、自行车与场景可见。' };
  const changed = (baselineStepId, description) => ({ kind: 'screen-change', baselineStepId, description });
  const journey = [
    { id: 'scene-ready', action: 'launch', inputs: [wait(700)], observe: [rendered], capture: '00-scene-ready.png' },
    { id: 'ride', action: 'start', inputs: actions.start.inputs, observe: [changed('scene-ready', astra ? '自动骑行持续推进，踩踏与轮转改变画面。' : '加速后骑行画面持续推进。')], capture: '01-ride.png' },
    { id: 'move', action: 'move', inputs: actions.move.inputs, observe: [changed('ride', astra ? '拖动后镜头位置改变。' : '变道后角色与道路的相对位置改变。')], capture: '02-move.png' },
    { id: 'primary', action: 'primary', inputs: actions.primary.inputs, observe: [changed('move', astra ? 'C 键切换至摄影棚并调整镜头。' : '空格触发骑行跳跃。'), ...(astra ? [visible('摄影棚 · 日落', '摄影棚成为当前场景。')] : [])], capture: '03-primary.png' },
    { id: 'pause', action: 'pause', inputs: actions.pause.inputs, observe: [visible('继续', '暂停按钮显示继续。')], capture: '04-pause.png' },
    { id: 'resume', action: 'pause', inputs: actions.pause.inputs, observe: [visible('暂停', '恢复后显示暂停按钮。')], capture: '05-resume.png' },
    { id: 'restart', action: 'restart', inputs: actions.restart.inputs, observe: [changed('resume', astra ? '重新开始回到海岸初始镜头。' : '重新开始恢复初始位置和骑行状态。'), rendered], capture: '06-restart.png' },
  ];
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    engine: 'web',
    entrypoint: { path: 'dist/index.html', readyTimeoutMs: 15000 },
    actions,
    journey,
    success: [rendered, { kind: 'element-visible', value: astra ? '#stage canvas' : '#app canvas', description: '重来后场景仍可继续操作。' }],
    limits: { maxRunMs: 60000, stepTimeoutMs: 8000 },
  };
}
