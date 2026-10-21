import { describe, expect, it } from 'vitest';
import { namespaceDesktopPreview } from './desktopPreviewPaths.js';
const base = '/desktop/preview/project/cap/';
describe('desktop preview project namespace', () => {
  it('loads absolute Vite scripts, styles, image URLs and CSS inside the project capability', () => {
    const html = '<script type="module" src="/assets/index.js"></script><link href="/assets/style.css"><img src="/assets/bird.png">';
    expect(namespaceDesktopPreview(Buffer.from(html), 'text/html; charset=utf-8', base).toString()).toBe(html.replaceAll('/assets/', `${base}assets/`));
    const js = 'const bird=new URL("/assets/bird.png",import.meta.url); fetch(`/assets/${name}.json`); let slash="/"; const absolute="https://external.example/a";';
    expect(namespaceDesktopPreview(Buffer.from(js), 'text/javascript', base).toString()).toBe(js.replaceAll('/assets/', `${base}assets/`));
    const css = '.bird{background:url(/assets/bird.png)}.other{background:url("/assets/bg.png")}';
    expect(namespaceDesktopPreview(Buffer.from(css), 'text/css', base).toString()).toBe(css.replaceAll('/assets/', `${base}assets/`));
  });
  it('keeps relative paths, external URLs and binary assets unchanged', () => {
    const text = '<img src="assets/bird.png"><img src="//cdn.example/bird.png"><script src="https://example/game.js"></script>';
    expect(namespaceDesktopPreview(Buffer.from(text), 'text/html', base).toString()).toBe(text);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    expect(namespaceDesktopPreview(png, 'image/png', base)).toBe(png);
  });
});
