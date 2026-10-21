import { createInterface } from 'node:readline/promises';
import { chmod, rename, writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';

const REGIONS = {
  '1': { label: '华北2（北京）', suffix: 'cn-beijing' },
  '2': { label: '新加坡', suffix: 'ap-southeast-1' },
  '3': { label: '美国（弗吉尼亚）', suffix: 'us-east-1' },
  '4': { label: '德国（法兰克福）', suffix: 'eu-central-1' },
  '5': { label: '日本（东京）', suffix: 'ap-northeast-1' },
};

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('请在 Mac 终端中运行 npm run web:setup');
  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write('百炼 API Key 的地域：\n1. 华北2（北京）\n2. 新加坡\n3. 美国（弗吉尼亚）\n4. 德国（法兰克福）\n5. 日本（东京）\n');
  const selection = (await rl.question('输入序号，直接回车选北京：')).trim() || '1';
  const region = REGIONS[selection];
  if (!region) { rl.close(); throw new Error('地域序号无效'); }
  const workspaceId = (await rl.question('输入百炼控制台「业务空间详情」中的 Workspace ID：')).trim();
  if (!/^[A-Za-z0-9-]{4,100}$/u.test(workspaceId)) {
    rl.close();
    throw new Error('Workspace ID 格式无效');
  }
  const baseUrl = `https://${workspaceId}.${region.suffix}.maas.aliyuncs.com/compatible-mode/v1`;
  rl.close();

  const key = (await readHidden('粘贴完整 API Key，按回车完成（输入不会显示）：')).trim();
  if (key.indexOf('sk-ws-', 6) !== -1) {
    throw new Error('检测到 API Key 被重复粘贴，请重新运行配置命令并只粘贴一次');
  }
  if (key.length < 10 || key.length > 4096 || /[\r\n\u0000-\u001f]/u.test(key)) {
    throw new Error('API Key 格式无效，请重新运行配置命令');
  }
  const file = resolve('.env.web.local');
  const temp = `${file}.${process.pid}.tmp`;
  const body = `DASHSCOPE_API_KEY=${JSON.stringify(key)}\nDASHSCOPE_BASE_URL=${JSON.stringify(baseUrl)}\n`;
  try {
    await writeFile(temp, body, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
    await chmod(file, 0o600);
  } catch (error) {
    const { rm } = await import('node:fs/promises');
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  stdout.write(`已保存 ${region.label} 的本机配置。运行 npm run web:serve 即可启动。\n`);
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    let value = '';
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    function finish(error) {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    }
    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u0003') { finish(new Error('已取消配置')); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && value.length < 4096) value += char;
      }
    }
    stdin.on('data', onData);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
