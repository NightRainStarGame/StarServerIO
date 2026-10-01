import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Sqlite = Database.Database;
export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseHandle {
  db: Db;
  sqlite: Sqlite;
}

/**
 * 打开（并按需创建）SQLite 数据库。
 *
 * - WAL：读写并发，读不阻塞写；
 * - busy_timeout：多进程/多连接写冲突时等待而不是立刻抛 SQLITE_BUSY；
 * - foreign_keys：SQLite 默认是关的，必须显式打开，否则外键约束形同虚设。
 */
export function openDatabase(dbPath: string): DatabaseHandle {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export function newId(): string {
  return randomUUID();
}
