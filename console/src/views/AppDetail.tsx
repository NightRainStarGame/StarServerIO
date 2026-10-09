import { useEffect, useMemo, useState } from 'react';
import {
  appApi,
  masterApi,
  CONSOLE_SESSION_SCOPES,
  SCOPE_PRESETS,
  type AnnouncementRecord,
  type ApiKeyRecord,
  type AppRecord,
  type CardBatchRecord,
  type ReleaseRecord,
} from '../api.js';
import { fmtBytes, fmtTime, maskSecret, type Session } from '../session.js';

type Tab = 'releases' | 'cards' | 'announcements' | 'keys';

export function AppDetail({
  session,
  app,
  onBack,
  onSessionChange,
}: {
  session: Session;
  app: AppRecord;
  onBack: () => void;
  onSessionChange: (s: Session) => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('releases');
  const apiKey = session.sessionKeys[app.id]?.key;

  const issueSessionKey = async (): Promise<void> => {
    const res = await masterApi(session.baseUrl, session.masterKey).keys.issue({
      appId: app.id,
      name: 'console-session',
      scopes: CONSOLE_SESSION_SCOPES,
    });
    onSessionChange({
      ...session,
      sessionKeys: { ...session.sessionKeys, [app.id]: { id: res.id, key: res.key } },
    });
  };

  return (
    <main>
      <div className="row">
        <button onClick={onBack}>← 应用列表</button>
        <h2>
          {app.name} <span className="mono muted">{app.slug}</span>
        </h2>
        <span className="spacer" />
        {apiKey ? (
          <span className="muted">会话 Key {maskSecret(apiKey)}</span>
        ) : (
          <button className="primary" onClick={() => void issueSessionKey()}>
            签发控制台会话 Key
          </button>
        )}
      </div>

      <nav className="tabs">
        {(['releases', 'cards', 'announcements', 'keys'] as Tab[]).map((t) => (
          <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'releases' ? '版本' : t === 'cards' ? '卡密' : t === 'announcements' ? '公告' : 'APIKey'}
          </button>
        ))}
      </nav>

      {apiKey ? (
        <>
          {tab === 'releases' ? <Releases session={session} apiKey={apiKey} /> : null}
          {tab === 'cards' ? <Cards session={session} app={app} /> : null}
          {tab === 'announcements' ? <Announcements session={session} apiKey={apiKey} /> : null}
          {tab === 'keys' ? <Keys session={session} app={app} /> : null}
        </>
      ) : (
        <p className="muted">业务数据需要 APIKey 才能读。先签发一个控制台会话 Key（只存在本机浏览器里）。</p>
      )}
    </main>
  );
}

function Releases({ session, apiKey }: { session: Session; apiKey: string }): JSX.Element {
  const api = useMemo(() => appApi(session.baseUrl, apiKey), [session.baseUrl, apiKey]);
  const [rows, setRows] = useState<ReleaseRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setRows(await api.releases.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => void load(), [api]);

  const patch = async (id: string, body: Partial<ReleaseRecord>): Promise<void> => {
    await api.releases.patch(id, body);
    await load();
  };

  return (
    <section>
      {error ? <p className="error">{error}</p> : null}
      <table>
        <thead>
          <tr>
            <th>版本</th>
            <th>渠道</th>
            <th>平台/架构</th>
            <th>大小</th>
            <th>灰度</th>
            <th>下载</th>
            <th>状态</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.version}</td>
              <td>{r.channel}</td>
              <td className="mono">
                {r.platform}/{r.arch}
              </td>
              <td>{fmtBytes(r.sizeBytes)}</td>
              <td>{r.rolloutPercent}%</td>
              <td>{r.downloadCount}</td>
              <td>{r.published ? '已发布' : '草稿'}</td>
              <td>
                <button onClick={() => void patch(r.id, { published: !r.published })}>
                  {r.published ? '下架' : '发布'}
                </button>
                <button onClick={() => void patch(r.id, { rolloutPercent: r.rolloutPercent >= 100 ? 10 : 100 })}>
                  灰度 {r.rolloutPercent >= 100 ? '10%' : '全量'}
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="muted">
                还没有版本。用 CLI 发版：ssio release publish --app &lt;slug&gt; --version 1.0.0 --file ./app.exe
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

// 卡密走 Master 通道：业务 APIKey 无权发卡
function Cards({ session, app }: { session: Session; app: AppRecord }): JSX.Element {
  const master = useMemo(() => masterApi(session.baseUrl, session.masterKey), [session]);
  const [rows, setRows] = useState<CardBatchRecord[]>([]);
  const [total, setTotal] = useState('100');
  const [days, setDays] = useState('30');
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (): Promise<void> => {
    try {
      setRows((await master.cards.list()).filter((b) => b.appId === app.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => void load(), [master, app.id]);

  const create = async (): Promise<void> => {
    setError(null);
    try {
      const batch = await master.cards.create(
        {
          name: `batch-${Date.now()}`,
          total: Number(total),
          expiresAt: days ? Date.now() + Number(days) * 86_400_000 : null,
          payload: { days: Number(days) },
        },
        app.id,
      );
      // 一次性导出链接只在创建时出现，之后无法再取 —— 立刻呈现给用户
      setLastExport(`${session.baseUrl.replace(/\/+$/, '')}${batch.exportUrl}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section>
      {error ? <p className="error">{error}</p> : null}
      <div className="row">
        <input className="narrow" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="张数" />
        <span>张</span>
        <input className="narrow" value={days} onChange={(e) => setDays(e.target.value)} placeholder="有效期" />
        <span>天</span>
        <button className="primary" onClick={() => void create()}>
          生成批次
        </button>
      </div>

      {lastExport ? (
        <p className="warn">
          明文导出链接（一次性，导出即销毁，刷新后不再显示）：
          <a href={lastExport} target="_blank" rel="noreferrer">
            下载 CSV
          </a>
        </p>
      ) : null}

      <table>
        <thead>
          <tr>
            <th>批次</th>
            <th>张数</th>
            <th>前缀</th>
            <th>有效期至</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td className="mono">{b.id.slice(0, 8)}…</td>
              <td>{b.generatedCount}</td>
              <td className="mono">{b.prefix || '—'}</td>
              <td>{fmtTime(b.expiresAt)}</td>
              <td>{fmtTime(b.createdAt)}</td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                还没有卡密批次
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

function Announcements({ session, apiKey }: { session: Session; apiKey: string }): JSX.Element {
  const api = useMemo(() => appApi(session.baseUrl, apiKey), [session.baseUrl, apiKey]);
  const [rows, setRows] = useState<AnnouncementRecord[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setRows(await api.announcements.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => void load(), [api]);

  const post = async (): Promise<void> => {
    setError(null);
    try {
      await api.announcements.create({ title, contentMd: body, pinned: false, level: 'info' });
      setTitle('');
      setBody('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section>
      {error ? <p className="error">{error}</p> : null}
      <div className="row">
        <input placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input placeholder="正文（markdown）" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="primary" onClick={() => void post()} disabled={!title || !body}>
          发布
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>标题</th>
            <th>级别</th>
            <th>生效</th>
            <th>结束</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>{a.title}</td>
              <td>{a.level}</td>
              <td>{fmtTime(a.startAt)}</td>
              <td>{fmtTime(a.endAt)}</td>
              <td>
                <button
                  onClick={async () => {
                    await api.announcements.remove(a.id);
                    await load();
                  }}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                还没有公告
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

function Keys({ session, app }: { session: Session; app: AppRecord }): JSX.Element {
  const master = useMemo(() => masterApi(session.baseUrl, session.masterKey), [session]);
  const [rows, setRows] = useState<ApiKeyRecord[]>([]);
  const [name, setName] = useState('key');
  const [preset, setPreset] = useState(1);
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setRows((await master.keys.list()).filter((k) => k.appId === app.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => void load(), [master, app.id]);

  const issue = async (): Promise<void> => {
    setError(null);
    try {
      const res = await master.keys.issue({ appId: app.id, name, scopes: SCOPE_PRESETS[preset]!.scopes });
      // 明文只出现这一次，之后只能看到掩码 —— 所以立刻提示复制
      setIssued(res.key);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section>
      {error ? <p className="error">{error}</p> : null}
      <div className="row">
        <input className="narrow" value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" />
        <select value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
          {SCOPE_PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => void issue()}>
          签发
        </button>
      </div>
      {issued ? (
        <p className="warn">
          明文只显示这一次：<code>{issued}</code>
        </p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>scopes</th>
            <th>创建</th>
            <th>吊销</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((k) => (
            <tr key={k.id} className={k.revokedAt ? 'dim' : ''}>
              <td>{k.name}</td>
              <td className="mono">{k.scopes.join(', ')}</td>
              <td>{fmtTime(k.createdAt)}</td>
              <td>{fmtTime(k.revokedAt)}</td>
              <td>
                {k.revokedAt ? null : (
                  <button
                    onClick={async () => {
                      await master.keys.revoke(k.id);
                      await load();
                    }}
                  >
                    吊销
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                还没有 Key
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
