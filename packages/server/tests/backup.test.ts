import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { createApp, createTestServer, issueKey, type TestServer } from './helpers.js';

/**
 * 备份 / 恢复（P6）：脚本是子进程真跑（不是 import 内部函数），
 * 数据库是真实 SQLite —— 恢复完数据必须真能读回来。
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const scriptsDir = resolve(here, '..', 'scripts');
const backupScript = join(scriptsDir, 'backup.mjs');
const restoreScript = join(scriptsDir, 'restore.mjs');

let t: TestServer;
let appId: string;
let apiKey: string;
let fileId: string;
let fileSha: string;
let backupDir: string;

/** 跑脚本，返回 stdout；失败时把 stdout/stderr 一起抛出来便于定位。 */
function run(script: string, args: string[]): string {
  try {
    return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    throw new Error(`脚本退出 ${err.status}\nstdout: ${err.stdout ?? ''}\nstderr: ${err.stderr ?? ''}`);
  }
}

/** 2 MB 文件走真实分片上传（分片下限是 1 MiB），让 storage 目录里有可验证的对象。 */
async function uploadFixture(): Promise<{ fileId: string; sha256: string }> {
  const chunk = 1024 * 1024;
  const payload = [Buffer.alloc(chunk, 1), Buffer.alloc(chunk, 2)];
  const sha256 = createHash('sha256').update(Buffer.concat(payload)).digest('hex');
  const init = await t.request
    .post('/v1/storage/uploads')
    .set('X-API-Key', apiKey)
    .send({ filename: 'backup-fixture.bin', totalSize: chunk * 2, chunkSize: chunk });
  for (let i = 0; i < payload.length; i++) {
    await t.request
      .put(`/v1/storage/uploads/${init.body.uploadId as string}/chunks/${i}`)
      .set('X-API-Key', apiKey)
      .set('content-type', 'application/octet-stream')
      .send(payload[i]!);
  }
  const done = await t.request
    .post(`/v1/storage/uploads/${init.body.uploadId as string}/complete`)
    .set('X-API-Key', apiKey)
    .send({ sha256 });
  return { fileId: done.body.fileId as string, sha256 };
}

function findFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}

beforeAll(async () => {
  t = await createTestServer();
  const app = await createApp(t.request, t.masterKey, 'backup-app');
  appId = app.id;
  apiKey = await issueKey(t.request, t.masterKey, { appId, scopes: ['storage:read', 'storage:write'] });
  const up = await uploadFixture();
  fileId = up.fileId;
  fileSha = up.sha256;
  // 停服务：备份本身不要求停（VACUUM INTO 可以在线做），但停了才能验证「恢复后重新打开可用」
  await t.app.close();
  t.sqlite.close();
}, 30_000);

afterAll(() => {
  // Windows 上 better-sqlite3 的句柄释放有延迟，直接删可能 EBUSY；
  // 目录是 os.tmpdir() 下的临时目录，删不掉不影响结论，不要让它把整个 suite 判失败
  try {
    rmSync(t.dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('备份与恢复', () => {
  it('backup 产出一致性快照 + 对象副本 + 元信息', () => {
    const out = run(backupScript, ['--data-dir', t.dataDir, '--out', join(t.dataDir, 'backups')]);
    expect(out).toContain('备份完成');

    const backups = readdirSync(join(t.dataDir, 'backups'));
    expect(backups.length).toBe(1);
    backupDir = join(t.dataDir, 'backups', backups[0]!);

    const meta = JSON.parse(readFileSync(join(backupDir, 'meta.json'), 'utf8')) as {
      backupVersion: number;
      dbBytes: number;
      storageFiles: number;
      storageBytes: number;
    };
    expect(meta.backupVersion).toBe(1);
    expect(meta.dbBytes).toBe(statSync(join(backupDir, 'ssio.db')).size);
    expect(meta.storageFiles).toBe(1);
    expect(meta.storageBytes).toBe(2 * 1024 * 1024);

    // 快照必须是自洽的单文件：脱离原库也能独立打开并查到数据
    const { sqlite } = openDatabase(join(backupDir, 'ssio.db'));
    const row = sqlite.prepare('select count(*) as n from files').get() as { n: number };
    expect(row.n).toBe(1);
    sqlite.close();
  }, 30_000);

  it('目标已有数据时默认拒绝覆盖，且不动现有数据', () => {
    const before = statSync(join(t.dataDir, 'ssio.db')).size;
    let failed = false;
    try {
      run(restoreScript, ['--from', backupDir, '--data-dir', t.dataDir]);
    } catch {
      failed = true;
    }
    expect(failed, '无 --force 时应以非 0 退出').toBe(true);
    expect(statSync(join(t.dataDir, 'ssio.db')).size).toBe(before);
    // 没留下 .pre-restore-* 残留
    expect(readdirSync(t.dataDir).some((f) => f.includes('pre-restore'))).toBe(false);
  }, 30_000);

  it('灾难后恢复：数据与对象全部回来', () => {
    // 模拟灾难：库与对象一起没了
    rmSync(join(t.dataDir, 'ssio.db'), { force: true });
    rmSync(join(t.dataDir, 'ssio.db-wal'), { force: true });
    rmSync(join(t.dataDir, 'ssio.db-shm'), { force: true });
    rmSync(join(t.dataDir, 'storage'), { recursive: true, force: true });
    expect(existsSync(join(t.dataDir, 'ssio.db'))).toBe(false);

    const out = run(restoreScript, ['--from', backupDir, '--data-dir', t.dataDir]);
    expect(out).toContain('恢复完成');

    // 库回来了：应用与文件记录都在（备份已包含迁移，不需要再跑）
    const { sqlite } = openDatabase(join(t.dataDir, 'ssio.db'));
    const apps = sqlite.prepare('select id from apps').all() as Array<{ id: string }>;
    const files = sqlite.prepare('select id, sha256 from files').all() as Array<{ id: string; sha256: string }>;
    expect(apps.map((a) => a.id)).toContain(appId);
    expect(files.map((f) => f.id)).toContain(fileId);
    expect(files[0]!.sha256).toBe(fileSha);
    sqlite.close();

    // 对象回来了：内容哈希与上传时一致
    const stored = findFiles(join(t.dataDir, 'storage'));
    expect(stored.length).toBe(1);
    expect(createHash('sha256').update(readFileSync(stored[0]!)).digest('hex')).toBe(fileSha);
  }, 30_000);
});
