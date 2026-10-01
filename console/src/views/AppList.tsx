import { useState } from 'react';
import { masterApi, type AppRecord } from '../api.js';
import { useApps } from '../App.js';
import { fmtBytes, fmtTime, type Session } from '../session.js';

export function AppList({ session, onSelect }: { session: Session; onSelect: (app: AppRecord) => void }): JSX.Element {
  const { apps, reload, error } = useApps(session);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [quotaMb, setQuotaMb] = useState('512');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await masterApi(session.baseUrl, session.masterKey).apps.create({
        slug,
        name: name || slug,
        quotaBytes: Math.round(Number(quotaMb || '512') * 1024 * 1024),
      });
      setSlug('');
      setName('');
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h2>应用</h2>
      {error ? <p className="error">{error}</p> : null}

      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>slug</th>
            <th>配额</th>
            <th>创建时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {apps.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td className="mono">{a.slug}</td>
              <td>{fmtBytes(a.quotaBytes)}</td>
              <td>{fmtTime(a.createdAt)}</td>
              <td>
                <button onClick={() => onSelect(a)}>管理</button>
              </td>
            </tr>
          ))}
          {apps.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                还没有应用，先建一个
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h3>新建应用</h3>
      <div className="row">
        <input placeholder="slug（小写字母数字-）" value={slug} onChange={(e) => setSlug(e.target.value)} />
        <input placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="narrow"
          placeholder="配额(MB)"
          value={quotaMb}
          onChange={(e) => setQuotaMb(e.target.value)}
        />
        <button className="primary" onClick={() => void create()} disabled={busy || slug.length < 3}>
          创建
        </button>
      </div>
      {msg ? <p className="error">{msg}</p> : null}
    </main>
  );
}
