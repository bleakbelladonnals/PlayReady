import { useEffect, useRef, useState, type FormEvent } from 'react';
import { App } from './App';
import { consumeDesktopConnectionKey, type createBrowserDesktopApi } from './browserApi';
import './browserDesktop.css';

type DesktopBridge = ReturnType<typeof createBrowserDesktopApi>;

export function BrowserDesktopApp({ bridge }: { bridge: DesktopBridge }) {
  const [connection, setConnection] = useState(bridge.getConnection);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const initialConnectionStarted = useRef(false);

  async function reconnect(token?: string) {
    setBusy(true);
    setError('');
    try {
      if (token) await bridge.connect(token);
      else await bridge.api.bootstrap();
      setKey('');
      setReady(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接本机工作台');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => bridge.onConnection(setConnection), [bridge]);
  useEffect(() => {
    const connectFromFragment = () => {
      const token = consumeDesktopConnectionKey(window.location, window.history);
      if (token) void reconnect(token);
      return Boolean(token);
    };
    window.addEventListener('hashchange', connectFromFragment);
    if (!initialConnectionStarted.current) {
      initialConnectionStarted.current = true;
      if (!connectFromFragment()) void reconnect();
    }
    return () => window.removeEventListener('hashchange', connectFromFragment);
  }, [bridge]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void reconnect(key);
  }

  if (ready) {
    return <>
      <App />
      {!connection.connected ? (
        <aside className="desktop-connection-banner" role="status">
          <span>{connection.message || '与本机工作台的连接中断，正在重新连接…'}</span>
          <button type="button" onClick={() => window.location.reload()}>重新连接</button>
        </aside>
      ) : null}
    </>;
  }

  return (
    <main className="desktop-connection-page">
      <section className="desktop-connection-panel" aria-labelledby="desktop-connection-title">
        <p className="desktop-connection-brand">PLAYREADY</p>
        <h1 id="desktop-connection-title">连接你的游戏工作台</h1>
        <p>这是你的私人工作台。它会连接到运行 PlayReady 和 Codex 的那台电脑；请保持那台电脑开机、联网且后台运行。</p>
        <p>第一次在另一台电脑使用时，在这台电脑的项目目录运行 <code>npm run desktop:web:pair</code>，把复制的私人连接链接发给自己，再到另一台电脑粘贴打开。</p>
        {connection.requiresKey ? (
          <form onSubmit={submit}>
            <label htmlFor="desktop-connection-key">连接密钥</label>
            <input id="desktop-connection-key" type="password" value={key} autoComplete="off" autoFocus
              onChange={(event) => setKey(event.target.value)} placeholder="粘贴本机工作台提供的连接密钥" />
            <button type="submit" disabled={busy || !key.trim()}>{busy ? '正在连接…' : '连接工作台'}</button>
          </form>
        ) : (
          <button type="button" disabled={busy} onClick={() => void reconnect()}>{busy ? '正在连接…' : '重新连接'}</button>
        )}
        {error ? <p className="desktop-connection-error" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
