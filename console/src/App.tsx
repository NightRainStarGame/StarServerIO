import { useCallback, useEffect, useMemo, useState } from 'react';
import { masterApi, type AppRecord } from './api.js';
import { AppDetail } from './views/AppDetail.js';
import { AppList } from './views/AppList.js';
import { clearSession, loadSession, maskSecret, saveSession, type Session } from './session.js';

export function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [baseUrl, setBaseUrl] = useState(session?.baseUrl ?? 'http://127.0.0.1:8100');
  const [masterKey, setMasterKey] = useState('');
  const [selected, setSelected] = useState<AppRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const login = async (): Promise<void> => {
    setError(null);
    try {
      // 登录即校验：拉一次应用列表，Key 不对会在这里被拒
      await masterApi(baseUrl, masterKey).apps.list();
      const next: Session = { baseUrl, masterKey, sessionKeys: session?.sessionKeys ?? {} };
      saveSession(next);
      setSession(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const logout = (): void => {
    clearSession();
    setSession(null);
    setSelected(null);
    setMasterKey('');
  };

  const updateSession = useCallback((next: Session) => {
    saveSession(next);
    setSession(next);
  }, []);

  if (!session) {
    return (
      <div className="login">
        <div className="card">
          <h1>SSIO 控制台</h1>
          <p className="muted">用 Master Key 登录。它只存在这台浏览器里，不会发往别处。</p>
          <label>
            服务地址
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:8100" />
          </label>
          <label>
            Master Key
            <input type="password" value={masterKey} onChange={(e) => setMasterKey(e.target.value)} />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button className="primary" onClick={() => void login()} disabled={!masterKey}>
            登录
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header>
        <span className="brand">SSIO</span>
        <span className="muted">{session.baseUrl}</span>
        <span className="spacer" />
        <span className="muted">Master {maskSecret(session.masterKey)}</span>
        <button onClick={logout}>退出</button>
      </header>
      {selected ? (
        <AppDetail
          session={session}
          app={selected}
          onBack={() => setSelected(null)}
          onSessionChange={updateSession}
        />
      ) : (
        <AppList session={session} onSelect={setSelected} />
      )}
    </div>
  );
}

/** 供 AppList 复用：把应用列表的刷新逻辑集中在这里，避免各视图各写一份。 */
export function useApps(session: Session): {
  apps: AppRecord[];
  reload: () => void;
  error: string | null;
} {
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void masterApi(session.baseUrl, session.masterKey)
      .apps.list()
      .then(setApps)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [session.baseUrl, session.masterKey, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return useMemo(() => ({ apps, reload, error }), [apps, reload, error]);
}
