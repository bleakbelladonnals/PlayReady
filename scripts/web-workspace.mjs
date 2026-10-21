import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const workspaceId = process.argv[2]?.trim() || '';
if (!/^[A-Za-z0-9-]{4,100}$/u.test(workspaceId)) {
  throw new Error('请运行 npm run web:workspace -- 你的WorkspaceId（在百炼控制台的「业务空间详情」中查看）');
}

const file = resolve('.env.web.local');
const values = parseEnv(await readFile(file, 'utf8'));
const key = values.DASHSCOPE_API_KEY;
const currentBase = values.DASHSCOPE_BASE_URL;
if (!key || !currentBase) throw new Error('本机百炼配置不完整，请运行 npm run web:setup');

const hostname = new URL(currentBase).hostname;
const region = hostname === 'dashscope.aliyuncs.com' ? 'cn-beijing'
  : hostname === 'dashscope-intl.aliyuncs.com' ? 'ap-southeast-1'
    : /\.([a-z0-9-]+)\.maas\.aliyuncs\.com$/u.exec(hostname)?.[1];
if (!region || !['cn-beijing', 'ap-southeast-1', 'us-east-1', 'eu-central-1', 'ap-northeast-1'].includes(region)) {
  throw new Error('无法识别原配置的地域，请运行 npm run web:setup');
}

const baseUrl = `https://${workspaceId}.${region}.maas.aliyuncs.com/compatible-mode/v1`;
const temp = `${file}.${process.pid}.tmp`;
try {
  await writeFile(temp, `DASHSCOPE_API_KEY=${JSON.stringify(key)}\nDASHSCOPE_BASE_URL=${JSON.stringify(baseUrl)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
  await chmod(file, 0o600);
} catch (error) {
  const { rm } = await import('node:fs/promises');
  await rm(temp, { force: true }).catch(() => undefined);
  throw error;
}
process.stdout.write('已更新业务空间地址，API Key 保持原值。\n');
