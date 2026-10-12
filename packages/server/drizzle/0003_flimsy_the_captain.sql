CREATE TABLE `ai_model_prices` (
	`model` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`context` integer NOT NULL,
	`price_in_cny_per_million` real NOT NULL,
	`price_out_cny_per_million` real NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`key_id` text NOT NULL,
	`model` text NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`cost_cny` real DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ai_usage_app_created` ON `ai_usage` (`app_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_model_created` ON `ai_usage` (`model`,`created_at`);--> statement-breakpoint
-- ⚠️ 下面三条是 drizzle-kit 依据 schema.ts 生成的，但 `kv_entries` 实际上**不是**迁移建出来的：
-- 它由 packages/server/src/modules/kv.ts:37 的运行时 DDL（CREATE TABLE IF NOT EXISTS）创建。
-- 于是任何跑过 kv 模块的数据库（线上就是）都已经有这张表，原样的 CREATE TABLE 会直接报
-- "table kv_entries already exists" 并让 drizzle 迁移整体失败 —— 表现为服务起不来。
--
-- 所以这里手工改成幂等写法：全新数据库照常建表，已有的库直接跳过。
-- 代价是以后 schema.ts 与这条不再自动同步（改 kv_entries 结构要记得同步这里）。
CREATE TABLE IF NOT EXISTS `kv_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_kv_app_key` ON `kv_entries` (`app_id`,`key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_kv_app_key` ON `kv_entries` (`app_id`,`key`);