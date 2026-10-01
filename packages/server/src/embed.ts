/**
 * 嵌入式复用入口（无副作用）。
 *
 * `@ssio/server` 的主入口 `index.ts` 会真的启动服务（读 .env → listen），
 * 以下场景需要复用构件但不能触发启动：
 * - SDK 的集成测试（@ssio/node）
 * - 把 SSIO 嵌进别的进程里跑（CLI 自检、单测夹具）
 * 这些从这里拿，import 本模块**不会**起服务。
 */
export { buildApp, type BuildAppOptions } from './app.js';
export { openDatabase, type Db, type Sqlite } from './db/client.js';
export { runMigrations } from './db/migrate.js';
export { configForTest } from './env.js';
