CREATE TABLE `forum_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`thread_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_forum_boards_slug` ON `forum_boards` (`app_id`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_forum_boards_app` ON `forum_boards` (`app_id`);--> statement-breakpoint
CREATE TABLE `forum_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content_md` text NOT NULL,
	`floor` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_forum_posts_floor` ON `forum_posts` (`thread_id`,`floor`);--> statement-breakpoint
CREATE INDEX `idx_forum_posts_thread` ON `forum_posts` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `forum_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`board_id` text NOT NULL,
	`title` text NOT NULL,
	`author_id` text NOT NULL,
	`content_md` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	`last_reply_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_forum_threads_board` ON `forum_threads` (`board_id`,`pinned`,`last_reply_at`);--> statement-breakpoint
CREATE INDEX `idx_forum_threads_app` ON `forum_threads` (`app_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `registry_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`latest_version` text,
	`download_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_registry_packages_name` ON `registry_packages` (`app_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_registry_packages_app` ON `registry_packages` (`app_id`);--> statement-breakpoint
CREATE TABLE `registry_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`package_id` text NOT NULL,
	`version` text NOT NULL,
	`channel` text DEFAULT 'stable' NOT NULL,
	`file_id` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`meta` text,
	`download_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_registry_versions` ON `registry_versions` (`package_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_registry_versions_pkg` ON `registry_versions` (`package_id`,`created_at`);