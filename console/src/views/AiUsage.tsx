import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  appApi,
  masterApi,
  CONSOLE_SESSION_SCOPES,
  type AiModelRecord,
  type AiUsageAggregate,
  type AiUsageRequestRecord,
  type AiUsageTotals,
  type AppRecord,
} from '../api.js';
import { appTitle, fmtTime, type Session } from '../session.js';

/**
 * AI 用量面板。
 *
 * ── 为什么是「逐应用各查一次再合并」而不是一次拿全量 ──
 * `/v1/ai/usage` 走的是 **APIKey** 面（要 ai:read），而 APIKey 天生带 app 归属，
 * 服务端强制按调用方 Key 的 app 过滤 —— 这是多租户红线，不能为了「一次看全量」去放宽。
 * Master Key 也不被那个端点接受（requireApiKey 只认 X-API-Key）。
 * 所以控制台的做法是：为每个应用确保一把会话 Key（含 ai:read），并发查出各自的数据，
 * 在前端合并成「全平台视图」。
 *
 * ── 成本口径 ──
 * 金额一律来自服务端按当时单价算好的 `cost_cny`，前端只做求和 ——
 * 不在前端重算成本，否则调价会让历史账单在界面上跟着变。
 */

const DAY = 86_400_000;

const EMPTY_TOTALS: AiUsageTotals = {
  requests: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cost_cny: 0,
};

const addTotals = (a: AiUsageTotals, b: AiUsageTotals): AiUsageTotals => ({
  requests: a.requests + b.requests,
  prompt_tokens: a.prompt_tokens + b.prompt_tokens,
  completion_tokens: a.completion_tokens + b.completion_tokens,
  total_tokens: a.total_tokens + b.total_tokens,
  cost_cny: a.cost_cny + b.cost_cny,
});

const fmtTokens = (n: number): string => n.toLocaleString('zh-CN');

/** 金额：小到 6 位小数（微元级），大额也不必拖一长串 0。 */
const fmtCny = (n: number): string => {
  if (n === 0) return '¥0';
  if (n < 0.01) return `¥${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `¥${n.toFixed(4)}`;
};

/** 本地日期的 YYYY-MM-DD（不用 toISOString：那会按 UTC 切日，跨时区会错一天）。 */
const dayKey = (d: Date): string => {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

interface AppUsage {
  app: AppRecord;
  totals: AiUsageTotals;
  days: AiUsageAggregate[];
  models: AiUsageAggregate[];
  requests: AiUsageRequestRecord[];
}

export function AiUsage({
  session,
  onBack,
  onSessionChange,
}: {
  session: Session;
  onBack: () => void;
  onSessionChange: (s: Session) => void;
}): JSX.Element {
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [usages, setUsages] = useState<AppUsage[]>([]);
  const [models, setModels] = useState<AiModelRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 查询失败（重签后仍失败）的应用：显式列出来，不再无声消失。 */
  const [failedApps, setFailedApps] = useState<string[]>([]);
  const [aggBy, setAggBy] = useState<'app' | 'model'>('app');
  const [copied, setCopied] = useState(false);

  const master = useMemo(() => masterApi(session.baseUrl, session.masterKey), [session.baseUrl, session.masterKey]);

  /** 确保每个应用都有一把带 ai:read 的会话 Key（缺则签发）。 */
  const ensureKeys = useCallback(
    async (list: AppRecord[]): Promise<Record<string, string>> => {
      const keys: Record<string, string> = {};
      const nextSession = { ...session, sessionKeys: { ...session.sessionKeys } };
      let changed = false;
      for (const app of list) {
        const existing = nextSession.sessionKeys[app.id]?.key;
        if (existing) {
          keys[app.id] = existing;
          continue;
        }
        const res = await master.keys.issue({
          appId: app.id,
          name: 'console-session',
          scopes: CONSOLE_SESSION_SCOPES,
          // 换钥即接管：其他浏览器的同名会话 Key 就地失效（那边会自动重签）
          revokeExisting: true,
        });
        nextSession.sessionKeys[app.id] = { id: res.id, key: res.key };
        keys[app.id] = res.key;
        changed = true;
      }
      if (changed) onSessionChange(nextSession);
      return keys;
    },
    [master, onSessionChange, session],
  );

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setFailedApps([]);
    try {
      const list = await master.apps.list();
      setApps(list);

      if (list.length === 0) {
        setUsages([]);
        setModels([]);
        return;
      }

      const keys = await ensureKeys(list);
      const from = new Date(Date.now() - 30 * DAY).toISOString();

      /** 缓存 Key 被吊销后重签的新 Key：跑完统一写回 session，避免闭包里的旧 session 互相覆盖。 */
      const reissued: Record<string, { id: string; key: string }> = {};
      const failed: string[] = [];

      const queryUsage = async (apiKey: string): Promise<Omit<AppUsage, 'app'>> => {
        const api = appApi(session.baseUrl, apiKey);
        const [byDay, byModel] = await Promise.all([
          api.ai.usage({ groupBy: 'day', from, detail: '1' }),
          api.ai.usage({ groupBy: 'model', from }),
        ]);
        return {
          totals: byDay.total,
          days: byDay.items,
          models: byModel.items,
          requests: byDay.requests ?? [],
        };
      };

      const results = await Promise.all(
        list.map(async (app): Promise<AppUsage | null> => {
          try {
            return { app, ...(await queryUsage(keys[app.id]!)) };
          } catch (e) {
            // 会话 Key 失效（KEY_REVOKED / KEY_EXPIRED，比如吊销了某应用全部 Key）→ 重签一把再试一次。
            // 之前这里是无差别静默吞掉 —— bigfish 吊销后整页「统计不了用量」就是这么来的。
            if (e instanceof ApiError && (e.status === 401 || e.code === 'KEY_EXPIRED')) {
              try {
                const fresh = await master.keys.issue({
                  appId: app.id,
                  name: 'console-session',
                  scopes: CONSOLE_SESSION_SCOPES,
                  revokeExisting: true,
                });
                reissued[app.id] = { id: fresh.id, key: fresh.key };
                return { app, ...(await queryUsage(fresh.key)) };
              } catch (e2) {
                failed.push(appTitle(app));
                void e2;
                return null;
              }
            }
            // 非鉴权类失败（网络 / 服务端 5xx）：不重试，但要显式暴露，不能再无声消失
            failed.push(appTitle(app));
            void e;
            return null;
          }
        }),
      );
      setUsages(results.filter((r): r is AppUsage => r !== null));
      setFailedApps(failed);
      if (Object.keys(reissued).length > 0) {
        onSessionChange({ ...session, sessionKeys: { ...session.sessionKeys, ...reissued } });
      }

      // 模型单价表：用任一应用的 Key 读即可（每个 app 看到的目录相同）
      const firstKey = keys[list[0]!.id];
      if (firstKey) {
        try {
          const m = await appApi(session.baseUrl, firstKey).ai.models();
          setModels(m.items);
        } catch {
          setModels([]);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [ensureKeys, master, onSessionChange, session.baseUrl, session.sessionKeys]);

  // 只在挂载时拉一次；后续由「刷新」按钮显式触发（load 的依赖含 session，随其变化重建）
  useEffect(() => {
    void load();
  }, [load]);

  /* ── 汇总 ── */
  const total30 = useMemo(
    () => usages.reduce((acc, u) => addTotals(acc, u.totals), EMPTY_TOTALS),
    [usages],
  );

  /** 近 30 天逐日合计（用于图表与窗口卡片）。缺失的日期补 0，否则图会「跳过」没请求的日子。 */
  const dailySeries = useMemo(() => {
    const map = new Map<string, AiUsageTotals>();
    for (let i = 29; i >= 0; i -= 1) {
      map.set(dayKey(new Date(Date.now() - i * DAY)), { ...EMPTY_TOTALS });
    }
    for (const u of usages) {
      for (const d of u.days) {
        const cur = map.get(d.key);
        if (cur) map.set(d.key, addTotals(cur, d));
      }
    }
    return [...map.entries()].map(([key, v]) => ({ key, ...v }));
  }, [usages]);

  const todayKey = dayKey(new Date());
  const windows = useMemo(() => {
    const pick = (n: number): AiUsageTotals =>
      dailySeries.slice(-n).reduce((acc, d) => addTotals(acc, d), { ...EMPTY_TOTALS });
    return {
      today: dailySeries.find((d) => d.key === todayKey) ?? { ...EMPTY_TOTALS },
      week: pick(7),
      month: pick(30),
    };
  }, [dailySeries, todayKey]);

  /** 按 app 切换的聚合表 */
  const byApp = useMemo(
    () =>
      usages
        .map((u) => ({ key: `${u.app.name}（${u.app.slug}）`, ...u.totals }))
        .sort((a, b) => b.total_tokens - a.total_tokens),
    [usages],
  );

  /** 按 model 切换：跨应用同名模型相加 */
  const byModel = useMemo(() => {
    const map = new Map<string, AiUsageTotals>();
    for (const u of usages) {
      for (const m of u.models) {
        map.set(m.key, addTotals(map.get(m.key) ?? { ...EMPTY_TOTALS }, m));
      }
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.total_tokens - a.total_tokens);
  }, [usages]);

  const recent = useMemo(
    () => usages.flatMap((u) => u.requests).sort((a, b) => b.created_at - a.created_at).slice(0, 50),
    [usages],
  );

  const rows: Array<AiUsageAggregate> = aggBy === 'app' ? byApp : byModel;

  const appNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of apps) m.set(a.id, `${a.name}（${a.slug}）`);
    return m;
  }, [apps]);

  const copyTodayJson = (): void => {
    const today = dailySeries.find((d) => d.key === todayKey) ?? { ...EMPTY_TOTALS };
    const payload = {
      date: todayKey,
      generated_at: new Date().toISOString(),
      total: {
        requests: today.requests,
        prompt_tokens: today.prompt_tokens,
        completion_tokens: today.completion_tokens,
        total_tokens: today.total_tokens,
        cost_cny: Number(today.cost_cny.toFixed(6)),
      },
      by_app: usages.map((u) => {
        const d = u.days.find((x) => x.key === todayKey);
        return {
          app: u.app.slug,
          requests: d?.requests ?? 0,
          prompt_tokens: d?.prompt_tokens ?? 0,
          completion_tokens: d?.completion_tokens ?? 0,
          total_tokens: d?.total_tokens ?? 0,
          cost_cny: Number((d?.cost_cny ?? 0).toFixed(6)),
        };
      }),
    };
    void navigator.clipboard
      .writeText(JSON.stringify(payload, null, 2))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setError('复制失败：浏览器拒绝了剪贴板访问'));
  };

  const maxTokens = Math.max(1, ...dailySeries.map((d) => d.total_tokens));

  return (
    <main>
      <div className="row">
        <button onClick={onBack}>← 应用列表</button>
        <h2>AI 用量</h2>
        <span className="spacer" />
        <button onClick={() => void load()} disabled={busy}>
          {busy ? '刷新中…' : '刷新'}
        </button>
        <button className="primary" onClick={copyTodayJson} disabled={busy}>
          {copied ? '已复制 ✓' : '复制今日用量 JSON'}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {failedApps.length > 0 ? (
        <p className="warn">以下应用的用量获取失败（已尝试重签会话 Key）：{failedApps.join('、')}</p>
      ) : null}
      {apps.length === 0 && !busy ? <p className="muted">还没有应用，先建一个再回来看用量。</p> : null}

      {apps.length > 0 ? (
        <>
          <div className="stat-cards">
            {([
              ['今日', windows.today],
              ['近 7 日', windows.week],
              ['近 30 日', windows.month],
            ] as Array<[string, AiUsageTotals]>).map(([label, t]) => (
              <div className="stat-card" key={label}>
                <div className="muted">{label}</div>
                <div className="stat-main">{fmtCny(t.cost_cny)}</div>
                <div className="muted mono">
                  {fmtTokens(t.requests)} 次 · {fmtTokens(t.total_tokens)} tokens
                </div>
                <div className="muted mono dim">
                  入 {fmtTokens(t.prompt_tokens)} / 出 {fmtTokens(t.completion_tokens)}
                </div>
              </div>
            ))}
          </div>

          <h3>近 30 日 tokens 趋势</h3>
          <TrendChart series={dailySeries} maxTokens={maxTokens} />

          <h3>聚合</h3>
          <div className="tabs">
            <button className={aggBy === 'app' ? 'active' : ''} onClick={() => setAggBy('app')}>
              按应用
            </button>
            <button className={aggBy === 'model' ? 'active' : ''} onClick={() => setAggBy('model')}>
              按模型
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>{aggBy === 'app' ? '应用' : '模型'}</th>
                <th>请求</th>
                <th>prompt</th>
                <th>completion</th>
                <th>total</th>
                <th>成本</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td className="mono">{fmtTokens(r.requests)}</td>
                  <td className="mono">{fmtTokens(r.prompt_tokens)}</td>
                  <td className="mono">{fmtTokens(r.completion_tokens)}</td>
                  <td className="mono">{fmtTokens(r.total_tokens)}</td>
                  <td className="mono">{fmtCny(r.cost_cny)}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    近 30 天没有记录
                  </td>
                </tr>
              ) : (
                <tr>
                  <td className="muted">合计</td>
                  <td className="mono">{fmtTokens(total30.requests)}</td>
                  <td className="mono">{fmtTokens(total30.prompt_tokens)}</td>
                  <td className="mono">{fmtTokens(total30.completion_tokens)}</td>
                  <td className="mono">{fmtTokens(total30.total_tokens)}</td>
                  <td className="mono">{fmtCny(total30.cost_cny)}</td>
                </tr>
              )}
            </tbody>
          </table>

          <h3>模型单价（元 / 百万 token）</h3>
          <table>
            <thead>
              <tr>
                <th>模型</th>
                <th>上下文</th>
                <th>输入价</th>
                <th>输出价</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.label} <span className="mono muted">{m.id}</span>
                  </td>
                  <td className="mono">{fmtTokens(m.context)}</td>
                  <td className="mono">¥{m.price_in_cny_per_million}</td>
                  <td className="mono">¥{m.price_out_cny_per_million}</td>
                </tr>
              ))}
              {models.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    读不到模型目录（该应用的会话 Key 需要 ai:read）
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="muted dim">改价走 API：PATCH /v1/ai/models/:model（Master Key）。改价只影响之后的请求，历史账单不变。</p>

          <h3>最近 50 条请求</h3>
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>应用</th>
                <th>Key</th>
                <th>模型</th>
                <th>tokens</th>
                <th>成本</th>
                <th>延迟</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td>{fmtTime(r.created_at)}</td>
                  <td>{appNameById.get(r.app) ?? r.app.slice(0, 8)}</td>
                  <td className="mono dim">{r.key_id.slice(0, 8)}</td>
                  <td className="mono">{r.model}</td>
                  <td className="mono">
                    {fmtTokens(r.total_tokens)}
                    <span className="dim"> ({fmtTokens(r.prompt_tokens)}+{fmtTokens(r.completion_tokens)})</span>
                  </td>
                  <td className="mono">{fmtCny(r.cost_cny)}</td>
                  <td className="mono">{r.latency_ms} ms</td>
                  <td>
                    <span className={r.status === 'ok' ? '' : r.status === 'aborted' ? 'warn' : 'error'}>
                      {r.status === 'ok' ? '成功' : r.status === 'aborted' ? '断开' : '失败'}
                    </span>
                    {r.error_code ? <span className="dim mono"> {r.error_code}</span> : null}
                  </td>
                </tr>
              ))}
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    还没有请求记录
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </>
      ) : null}
    </main>
  );
}

/**
 * 逐日 tokens 柱状图。手写 SVG，不引图表库：
 * 整张图就 30 根柱子 + 两条基准线，引一个几百 KB 的依赖不划算。
 */
function TrendChart({
  series,
  maxTokens,
}: {
  series: Array<AiUsageTotals & { key: string }>;
  maxTokens: number;
}): JSX.Element {
  const W = 720;
  const H = 150;
  const padL = 8;
  const padB = 18;
  const barGap = 2;
  const barW = (W - padL * 2) / series.length - barGap;
  const plotH = H - padB;

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="近 30 日 tokens 趋势">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={padL}
            x2={W - padL}
            y1={plotH * (1 - f)}
            y2={plotH * (1 - f)}
            stroke="var(--line)"
            strokeWidth={1}
          />
        ))}
        {series.map((d, i) => {
          const h = d.total_tokens === 0 ? 0 : Math.max(2, (d.total_tokens / maxTokens) * plotH);
          const x = padL + i * (barW + barGap);
          return (
            <g key={d.key}>
              <rect
                x={x}
                y={plotH - h}
                width={barW}
                height={h}
                fill={d.key === dayKey(new Date()) ? 'var(--warn)' : 'var(--accent)'}
              />
              <title>{`${d.key}：${d.total_tokens} tokens · ${d.requests} 次 · ¥${d.cost_cny.toFixed(6)}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="chart-axis muted mono">
        <span>{series[0]?.key}</span>
        <span>峰值 {fmtTokens(maxTokens)} tokens</span>
        <span>{series[series.length - 1]?.key}</span>
      </div>
    </div>
  );
}
