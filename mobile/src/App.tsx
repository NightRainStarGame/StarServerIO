import { useCallback, useEffect, useState } from 'react';
import { createClient, type SsioClient } from '@ssio/web';
import './styles.css';

/**
 * SSIO 移动端壳。
 *
 * 它的存在意义不是"做一个 App"，而是**验证 @ssio/web 在真机 WebView 里能用**：
 * localStorage 持久化、并发分片上传、网络抖动下的重试与续期，这些在 node 环境
 * 测不出来。所以功能刻意做得薄：配置 → 更新检查 → 公告 → 卡密核销。
 */

interface Settings {
  baseUrl: string;
  apiKey: string;
  appSlug: string;
  platform: 'win' | 'linux' | 'android' | 'any';
  /** 灰度分桶用的稳定标识，装一次生成一个，之后不变。 */
  clientId: string;
}

const SETTINGS_KEY = 'ssio.mobile.settings';
const CLIENT_ID_KEY = 'ssio.mobile.clientId';

function loadSettings(): Settings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  const base: Settings = {
    baseUrl: 'http://10.0.2.2:8100', // Android 模拟器访问宿主的地址
    apiKey: '',
    appSlug: '',
    platform: 'android',
    clientId: localStorage.getItem(CLIENT_ID_KEY) ?? '',
  };
  if (!base.clientId) {
    base.clientId = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, base.clientId);
  }
  return raw ? { ...base, ...(JSON.parse(raw) as Partial<Settings>) } : base;
}

export function App(): JSX.Element {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [tab, setTab] = useState<'update' | 'news' | 'card' | 'settings'>('settings');
  const [log, setLog] = useState<string[]>([]);

  const say = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 30));
  }, []);

  const client: SsioClient | null = settings.baseUrl && settings.apiKey
    ? createClient({ baseUrl: settings.baseUrl, apiKey: settings.apiKey })
    : null;

  const save = (patch: Partial<Settings>): void => {
    const next = { ...settings, ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    setSettings(next);
  };

  return (
    <div className="app">
      <header>
        <strong>SSIO</strong>
        <span className="muted">{settings.appSlug || '未配置应用'}</span>
      </header>

      <main>
        {!client ? (
          <p className="muted">先到「设置」填服务地址与 APIKey。</p>
        ) : tab === 'update' ? (
          <UpdateTab client={client} settings={settings} say={say} />
        ) : tab === 'news' ? (
          <NewsTab client={client} say={say} />
        ) : tab === 'card' ? (
          <CardTab client={client} say={say} />
        ) : null}

        {tab === 'settings' ? (
          <section>
            <label>
              服务地址
              <input value={settings.baseUrl} onChange={(e) => save({ baseUrl: e.target.value })} />
            </label>
            <label>
              APIKey（需要 release:read / announcements:read / cards:redeem）
              <input value={settings.apiKey} onChange={(e) => save({ apiKey: e.target.value })} />
            </label>
            <label>
              应用 slug
              <input value={settings.appSlug} onChange={(e) => save({ appSlug: e.target.value })} />
            </label>
            <label>
              平台
              <select value={settings.platform} onChange={(e) => save({ platform: e.target.value as Settings['platform'] })}>
                <option value="android">android</option>
                <option value="win">win</option>
                <option value="linux">linux</option>
                <option value="any">any</option>
              </select>
            </label>
            <p className="muted">
              灰度标识 clientId：{settings.clientId.slice(0, 8)}…（装一次生成一次，卸载重装会换，
              灰度也就跟着换桶 —— 这是刻意的：灰度分桶按安装计，不按账号计）
            </p>
          </section>
        ) : null}

        <h3>日志</h3>
        <pre className="log">{log.join('\n') || '（空）'}</pre>
      </main>

      <nav>
        {(['update', 'news', 'card', 'settings'] as const).map((t) => (
          <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'update' ? '更新' : t === 'news' ? '公告' : t === 'card' ? '卡密' : '设置'}
          </button>
        ))}
      </nav>
    </div>
  );
}

function UpdateTab({
  client,
  settings,
  say,
}: {
  client: SsioClient;
  settings: Settings;
  say: (s: string) => void;
}): JSX.Element {
  const [current, setCurrent] = useState('0.0.0');
  const [result, setResult] = useState<string>('');

  const check = async (): Promise<void> => {
    try {
      const res = await client.releases.latest({
        platform: settings.platform,
        arch: 'any',
        channel: 'stable',
        current,
        clientId: settings.clientId,
      });
      setResult(JSON.stringify(res, null, 2));
      say(res.hasUpdate ? `发现更新 ${res.version}` : '已是最新');
    } catch (e) {
      say(`检查失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <section>
      <label>
        当前版本
        <input value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <button className="primary" onClick={() => void check()}>
        检查更新
      </button>
      <pre className="log">{result}</pre>
    </section>
  );
}

function NewsTab({ client, say }: { client: SsioClient; say: (s: string) => void }): JSX.Element {
  const [items, setItems] = useState<Array<{ id: string; title: string; contentMd: string; level: string }>>([]);

  useEffect(() => {
    void client.announcements
      .active()
      .then((list) => setItems(list as typeof items))
      .catch((e: unknown) => say(`拉取失败：${e instanceof Error ? e.message : String(e)}`));
    // 只在挂载时拉一次：client 每次渲染都是新对象，放进依赖数组会无限循环
  }, []);

  return (
    <section>
      {items.map((a) => (
        <article key={a.id}>
          <h4>
            {a.title} <span className="muted">{a.level}</span>
          </h4>
          <p>{a.contentMd}</p>
        </article>
      ))}
      {items.length === 0 ? <p className="muted">暂无生效中的公告</p> : null}
    </section>
  );
}

function CardTab({ client, say }: { client: SsioClient; say: (s: string) => void }): JSX.Element {
  const [code, setCode] = useState('');

  const redeem = async (): Promise<void> => {
    try {
      const res = await client.cards.redeem({ code: code.trim() });
      say(`核销成功：${JSON.stringify(res.payload ?? {})}`);
    } catch (e) {
      say(`核销失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <section>
      <label>
        卡密
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" />
      </label>
      <button className="primary" onClick={() => void redeem()} disabled={!code.trim()}>
        核销
      </button>
    </section>
  );
}
