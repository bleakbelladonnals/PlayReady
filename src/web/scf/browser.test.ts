import { describe, expect, it } from 'vitest';
import { browserConfig, runtimeInfo, safeChromiumArguments } from './browser.js';

describe('SCF Chromium configuration', () => {
  it('preserves required process flags without disabling preview security or BrowserContexts', () => {
    const args = safeChromiumArguments([
      '--single-process', '--disable-web-security', '--allow-running-insecure-content',
      '--disable-site-isolation-trials', '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
      '--no-sandbox', '--no-zygote', '--headless=shell', '--disable-webgl',
    ]);
    expect(args).toEqual([
      '--disable-features=AudioServiceOutOfProcess', '--no-sandbox', '--no-zygote',
      '--headless=shell', '--disable-webgl', '--disable-dev-shm-usage', '--mute-audio',
    ]);
  });

  it('returns only runtime facts and rejects incompatible local machines before unpacking a Linux binary', async () => {
    expect(Object.keys(runtimeInfo()).sort()).toEqual(['arch', 'glibc', 'node', 'platform']);
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      await expect(browserConfig()).rejects.toThrow('Linux x86_64');
    }
  });
});
