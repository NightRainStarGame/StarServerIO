import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './client.js';

// 迁移 SQL 由 `pnpm db:generate`（drizzle-kit）产出，禁止手写建表语句。
// 无论从 src（vitest/tsx）还是 dist（编译后）运行，都指向 packages/server/drizzle/
const migrationsFolder = fileURLToPath(new URL('../../drizzle/', import.meta.url));

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder });
}

export { migrationsFolder };
