#!/usr/bin/env node
/**
 * SSIO 数据恢复（backup.mjs 的逆操作）。
 *
 * 安全设计（恢复是破坏性操作，脚本必须自己扛住误操作）：
 * 1. 目标已有数据时**默认拒绝**，必须显式 `--force`；
 * 2. 覆盖前先把现有 db / storage 改名成 `.pre-restore-<时间戳>`，不直接删 —— 恢复错了能救回来；
 * 3. WAL 残留必清：只替换主库而不删 `-wal/-shm`，SQLite 会拿旧 WAL 去回放新库 → 直接损坏。
 *
 * 用法：node packages/server/scripts/restore.mjs --from <备份目录> [--data-dir <dir>] [--force]
 */
/* eslint-disable no-console */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.from) {
  console.log('用法: node packages/server/scripts/restore.mjs --from <备份目录> [--data-dir <dir>] [--force]');
  process.exit(args.help ? 0 : 1);
}

const from = resolve(String(args.from));
const dataDir = resolve(args['data-dir'] ?? process.env.DATA_DIR ?? './data');
const force = args.force === true;

const metaPath = join(from, 'meta.json');
const backupDb = join(from, 'ssio.db');
if (!existsSync(backupDb)) {
  console.error(`备份目录里没有 ssio.db：${from}`);
  process.exit(1);
}
let meta = null;
if (existsSync(metaPath)) {
  meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (meta.backupVersion !== 1) {
    console.error(`不认识的备份格式（backupVersion=${meta.backupVersion}），本脚本只支持 v1`);
    process.exit(1);
  }
}

const dbPath = join(dataDir, 'ssio.db');
const storageDir = join(dataDir, 'storage');
const hasExisting = existsSync(dbPath) || existsSync(storageDir);

if (hasExisting && !force) {
  console.error(
    `目标已存在数据（${dbPath}），拒绝覆盖。\n确认无误后加 --force；现有数据会被改名为 .pre-restore-<时间戳> 保留。`,
  );
  process.exit(1);
}

const stamp = timestamp();

// 1) 现有数据让位（不删除，改名保留）
if (existsSync(dbPath)) {
  renameSync(dbPath, `${dbPath}.pre-restore-${stamp}`);
}
// WAL 残留必须清掉：否则新库会去回放旧 WAL
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
if (existsSync(storageDir)) {
  renameSync(storageDir, `${storageDir}.pre-restore-${stamp}`);
}

// 2) 落回数据
mkdirSync(dataDir, { recursive: true });
cpSync(backupDb, dbPath);
const backupStorage = join(from, 'storage');
let storageFiles = 0;
if (existsSync(backupStorage)) {
  cpSync(backupStorage, storageDir, { recursive: true });
  storageFiles = countFiles(storageDir);
}

console.log(`恢复完成 → ${dataDir}`);
console.log(
  `  数据库 ${(statSync(dbPath).size / 1024).toFixed(1)} KB${meta ? `（备份于 ${meta.createdAt}）` : '（备份缺少 meta.json）'}`,
);
console.log(`  存储对象 ${storageFiles} 个`);
if (hasExisting) console.log(`  原数据已保留为 *.pre-restore-${stamp}（确认无误后可自行删除）`);
console.log('  提示：恢复前请先停掉 SSIO 服务，避免正在写入的进程与恢复打架。');

// ---- helpers ----

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function countFiles(root) {
  let n = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else n++;
    }
  };
  walk(root);
  return n;
}
