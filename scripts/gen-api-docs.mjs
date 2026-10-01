#!/usr/bin/env node
/**
 * 从服务端源码真实提取路由，生成 docs/03-API参考.md。
 *
 * 为什么提取而不是手写：手写文档和代码一定会漂移（P2 时 README 里的接口表
 * 就是手写的，加字段时忘了同步）。这里扫描 `src/modules/*.ts` 里的
 * `app.<method>('<path>', ...)` 与 `preHandler` 里的鉴权声明，两者都在源码里，
 * 加路由不改文档也能保持一致 —— CI 用 `--check` 卡住漂移。
 *
 * 用法：
 *   node scripts/gen-api-docs.mjs            # 写入 docs/03-API参考.md
 *   node scripts/gen-api-docs.mjs --check    # 只比对，不同则退出码 1（给 CI 用）
 *   node scripts/gen-api-docs.mjs --print    # 打到 stdout，不落盘
 */
/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows 下 file:// 的 pathname 带前导斜杠（/D:/...），必须用 fileURLToPath 转
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modulesDir = join(repoRoot, 'packages', 'server', 'src', 'modules');
const outPath = join(repoRoot, 'docs', '03-API参考.md');

const check = process.argv.includes('--check');
const print = process.argv.includes('--print');

const MODULE_LABELS = {
  health: '健康检查',
  apps: '应用',
  apikeys: 'APIKey',
  auth: '认证（登录 / 续期）',
  users: '用户',
  storage: '存储',
  releases: '发行',
  cards: '卡密',
  announcements: '公告',
};

/**
 * 鉴权声明 → 文档里的说法。顺序有意义：先匹配更具体的（带 scopes），再匹配兜底的。
 *
 * 新增 preHandler helper 时这里必须同步 —— 忘了的话脚本会报「未识别」并以非零退出，
 * 故意不做静默兜底（静默兜底 = 文档悄悄失真，而这是最容易骗过 code review 的一类 bug）。
 */
const AUTH_PATTERNS = [
  [
    /requireApiKey\(\{[^}]*scopes:\s*\[([^\]]*)\]/,
    (m) => {
      const scopes = m[1]
        .split(',')
        .map((s) => s.trim().replace(/['"]/g, ''))
        .filter(Boolean);
      return scopes.length ? `APIKey（${scopes.join('、')}）` : 'APIKey（无 scope 要求）';
    },
  ],
  [/requireApiKey\(\s*\)/, () => 'APIKey（无 scope 要求）'],
  [/requireMasterOrAdmin\(\)/, () => 'Master Key 或 APIKey（admin:*）'],
  [/requireRedeemCaller\(\)/, () => 'APIKey（cards:redeem）或用户 JWT'],
  [/requireReader\(\)/, () => 'APIKey（announcements:read）或用户 JWT'],
  // 论坛发帖/回复只认用户身份：APIKey 代表应用，拿它发帖会分不清「谁说的」
  [/requireAuthor\(\)/, () => '用户 JWT（必须）'],
  [/requireUser\(\)/, () => '用户 JWT'],
  [/requireMaster\(\)/, () => 'Master Key'],
];

const routes = [];

for (const file of readdirSync(modulesDir).filter((f) => f.endsWith('.ts')).sort()) {
  const moduleName = file.replace(/\.ts$/, '');
  const source = readFileSync(join(modulesDir, file), 'utf8');
  // app.get(\n  '/v1/x',  或  app.get('/v1/x',
  const re = /app\.(get|post|put|patch|delete)\(\s*\n?\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const [, method, path] = m;
    // 路由定义往后取一屏，够覆盖 preHandler 块
    const window = source.slice(m.index, m.index + 600);
    routes.push({ module: moduleName, method: method.toUpperCase(), path, auth: parseAuth(window) });
  }
}

const unknown = routes.filter((r) => r.auth === null);
if (unknown.length > 0) {
  console.error('以下路由没识别出鉴权方式（preHandler 写法变了？）：');
  for (const r of unknown) console.error(`  ${r.method} ${r.path}  (${r.module}.ts)`);
  process.exit(1);
}

const markdown = render(routes);

if (print) {
  process.stdout.write(markdown);
} else if (check) {
  if (!existsSync(outPath)) {
    console.error(`文档不存在：${outPath}（先跑一次 pnpm gen:api-docs）`);
    process.exit(1);
  }
  const current = readFileSync(outPath, 'utf8');
  if (stripTimestamp(current) !== stripTimestamp(markdown)) {
    console.error('API 文档与源码不一致（路由改了没重新生成）。跑：pnpm gen:api-docs');
    process.exit(1);
  }
  console.log(`API 文档与源码一致（${routes.length} 条路由）`);
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');
  console.log(`已生成 ${outPath}（${routes.length} 条路由）`);
}

// ---- helpers ----

function parseAuth(window) {
  for (const [re, render2] of AUTH_PATTERNS) {
    const m = window.match(re);
    if (m) return render2(m);
  }
  // 无 preHandler：公开端点（健康检查一类）
  if (!/preHandler/.test(window)) return '公开';
  return null;
}

function render(routes) {
  const byModule = new Map();
  for (const r of routes) {
    if (!byModule.has(r.module)) byModule.set(r.module, []);
    byModule.get(r.module).push(r);
  }

  const lines = [
    '# SSIO API 参考',
    '',
    '> 本文件由 `pnpm gen:api-docs` 从 `packages/server/src/modules/*.ts` **自动生成**，不要手改。',
    `> 生成时间：${new Date().toISOString()} | 路由总数：${routes.length}`,
    '',
    '鉴权头：Master Key 用 `X-Master-Key`，APIKey 用 `X-API-Key`，用户用 `Authorization: Bearer <access>`。',
    '',
  ];

  for (const [module, list] of byModule) {
    lines.push(`## ${MODULE_LABELS[module] ?? module}（${module}.ts）`, '');
    lines.push('| 方法 | 路径 | 鉴权 |', '|---|---|---|');
    for (const r of list) lines.push(`| ${r.method} | \`${r.path}\` | ${r.auth} |`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function stripTimestamp(md) {
  return md.replace(/^> 生成时间：.*$/m, '> 生成时间：（略）');
}
