import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource/press-start-2p/latin-400.css';
import '@vp-tw/cjk-web-fonts-fusion-pixel-font/dist/12px/proportional/zh_hans/Fusion-Pixel-12px-Proportional-Simplified-Chinese.css';
import { App } from './App';
import { BrowserDesktopApp } from './BrowserDesktopApp';
import { createBrowserDesktopApi } from './browserApi';
import './styles.css';

const browserBridge = window.ludoready ? null : createBrowserDesktopApi();
if (browserBridge) {
  window.ludoready = browserBridge.api;
  window.ludoreadyBrowser = true;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {browserBridge ? <BrowserDesktopApp bridge={browserBridge} /> : <App />}
  </StrictMode>,
);
