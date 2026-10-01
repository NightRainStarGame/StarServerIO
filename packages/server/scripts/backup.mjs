#!/usr/bin/env node
/**
 * SSIO 数据备份。
 *
 * 产出目录：
 *   <out>/ssio-backup-<时间戳>/ssio.db     —— 数据库**一致性快照**（VACUUM INTO，不是裸文件复制）
 *   <out>/ssio-backup-<时间戳>/storage/    —— 存储对象（DATA_DIR/storage 的副本）
 *   <out>/ssio-backup-<时间戳>/meta.json   —— 备份元信息（体积/文件数/SQLite 版本）
 *
 * 为什么用 VACUUM INTO 而不是 cp ssio.db：
 *   服务在 WAL 模式下运行时，ssio.db 旁边还有 -wal/-shm，直接复制 db 文件拿到的
 *   可能是「主库 + 未 checkpoint 的 WAL」不一致的快照；VACUUM INTO 由 SQLite 引擎
 *   自己产出一个完整、自洽的单文件副本，服务不用停。
 *
 * 不备份 DATA_DIR/tmp（上传中的分片，本来就是临时态）。
 *
 * 用法：node packages/server/scripts/backup.mjs [--data-dir <dir>] [--out <dir>]
 * 环境变量 DATA_DIR 同样生效（与服务端一致）。
 */
/* eslint-disable no-console */
import Database from 'better-sqlite3';
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法: node packages/server/scripts/backup.mjs [--data-dir <dir>] [--out <dir>]');
  process.exit(0);
}

const dataDir = resolve(args['data-dir'] ?? process.env.DATA_DIR ?? './data');
const dbPath = join(dataDir, 'ssio.db');
const storageDir = join(dataDir, 'storage');
const outRoot = resolve(args.out ?? join(dataDir, 'backups'));

if (!existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}\n（用 --data-dir 指定，或设置 DATA_DIR 环境变量）`);
  process.exit(1);
}

const stamp = timestamp();
const target = join(outRoot, `ssio-backup-${stamp}`);
mkdirSync(target, { recursive: true });

// 1) 数据库一致性快照
const snapshot = join(target, 'ssio.db');
const t0 = Date.now();
const db = new Database(dbPath);
let sqliteVersion;
try {
  sqliteVersion = db.prepare('select sqlite_version() as v').get().v;
  db.exec(`VACUUM INTO ${quote(snapshot)}`);
} finally {
  db.close();
}
const dbMs = Date.now() - t0;
const dbBytes = statSync(snapshot).size;

// 2) 存储对象
const t1 = Date.now();
let storageFiles = 0;
let storageBytes = 0;
if (existsSync(storageDir)) {
  cpSync(storageDir, join(target, 'storage'), { recursive: true });
  const counted = countTree(join(target, 'storage'));
  storageFiles = counted.files;
  storageBytes = counted.bytes;
}
const storageMs = Date.now() - t1;

// 3) 元信息
const meta = {
  backupVersion: 1,
  createdAt: new Date().toISOString(),
  sourceDataDir: dataDir,
  sqliteVersion,
  dbBytes,
  storageFiles,
  storageBytes,
};

writeFileSync(join(target, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

console.log(`备份完成：${target}`);
console.log(`  数据库快照 ${(dbBytes / 1024).toFixed(1)} KB（${dbMs} ms，SQLite ${sqliteVersion}）`);
console.log(`  存储对象 ${storageFiles} 个 / ${(storageBytes / 1024 / 1024).toFixed(2)} MB（${storageMs} ms）`);
console.log(`  总耗时 ${Date.now() - t0} ms`);

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

/** VACUUM INTO 只接受字符串字面量，路径要自己加引号并转义单引号。 */
function quote(path) {
  return `'${path.replace(/'/g, "''")}'`;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function countTree(root) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files++;
        bytes += statSync(p).size;
      }
    }
  };
  walk(root);
  return { files, bytes };
}
