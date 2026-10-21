import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const configFile = new URL('../.env.desktop.local', import.meta.url);
let config;
try { config = parseEnv(await readFile(configFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  config = { LUDO_DESKTOP_SECRET: randomBytes(32).toString('base64url'), LUDOREADY_DESKTOP_WORKER_ID: randomUUID() };
  await writeFile(configFile, Object.entries(config).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
}
const localOrigin = `http://127.0.0.1:${config.LUDOREADY_DESKTOP_PORT || process.env.LUDOREADY_DESKTOP_PORT || 8790}`;
let alreadyRunning = false;
try {
  const response = await fetch(`${localOrigin}/desktop/connect`, {
    method: 'POST', headers: { Origin: localOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: config.LUDO_DESKTOP_SECRET }), redirect: 'error', signal: AbortSignal.timeout(1500),
  });
  alreadyRunning = response.ok && (await response.json()).connected === true;
} catch { /* No existing workbench; start the desktop backend below. */ }
if (process.argv.includes('--pair')) {
  if (!alreadyRunning) throw new Error('本机工作台尚未运行。请先在这台电脑运行 npm run desktop:web。');
  if (!config.LUDOREADY_DESKTOP_ORIGIN) throw new Error('尚未配置远程网站地址。');
  const url = `${config.LUDOREADY_DESKTOP_ORIGIN}/#connect=${encodeURIComponent(config.LUDO_DESKTOP_SECRET)}`;
  const clipboard = process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip' : 'wl-copy';
  const copied = spawnSync(clipboard, [], { input: url, stdio: ['pipe', 'ignore', 'ignore'] });
  if (copied.status !== 0) throw new Error('无法复制私人连接链接，请检查这台电脑的剪贴板服务。');
  process.stdout.write('私人连接链接已复制。请把它发送到你自己的另一台电脑并粘贴打开；这台电脑需要保持开机、联网且后台运行。\n');
  process.exit(0);
}
if (alreadyRunning) {
  if (!process.argv.includes('--no-open')) {
    const url = `${config.LUDOREADY_DESKTOP_ORIGIN || localOrigin}/#connect=${encodeURIComponent(config.LUDO_DESKTOP_SECRET)}`;
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const opened = spawnSync(command, args, { stdio: 'ignore' });
    if (opened.status !== 0) throw new Error('本机工作台正在运行，但浏览器未能自动打开。');
  }
  process.stdout.write('本机工作台已在运行。\n');
  process.exit(0);
}
if (!process.argv.includes('--no-build')) {
  for (const command of ['build:renderer', 'build:main']) {
    const result = spawnSync('npm', ['run', command], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
let binary = process.env.LUDOREADY_CODEX_BIN || config.LUDOREADY_CODEX_BIN;
if (!binary) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8' });
  if (result.status === 0) binary = result.stdout.trim().split(/\r?\n/u)[0];
}
const executable = fileURLToPath(new URL(`../node_modules/.bin/electron${process.platform === 'win32' ? '.cmd' : ''}`, import.meta.url));
const child = spawn(executable, ['.'], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, ...config, LUDOREADY_DESKTOP_WEB: '1', ...(binary ? { LUDOREADY_CODEX_BIN: binary } : {}),
    LUDOREADY_DESKTOP_OPEN_BROWSER: process.argv.includes('--no-open') ? '0' : '1',
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('exit', (code) => process.exit(code ?? 1));
