import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const localConfig = resolve('.env.web.local');
if (existsSync(localConfig)) {
  const values = parseEnv(readFileSync(localConfig, 'utf8'));
  for (const name of ['DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL']) {
    if (values[name] !== undefined) process.env[name] = values[name];
  }
}

const { startWebServer } = await import('../dist/web/server/server.js');
await startWebServer();
