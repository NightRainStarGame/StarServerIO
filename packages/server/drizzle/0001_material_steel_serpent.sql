CREATE TABLE `announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`title` text NOT NULL,
	`content_md` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_announcements_app` ON `announcements` (`app_id`,`start_at`);--> statement-breakpoint
CREATE TABLE `card_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`total` integer NOT NULL,
	`generated_count` integer DEFAULT 0 NOT NULL,
	`prefix` text,
	`code_length` integer NOT NULL,
	`charset` text NOT NULL,
	`payload` text,
	`export_ciphertext` text,
	`exported_at` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_card_batches_app` ON `card_batches` (`app_id`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`code_mask` text NOT NULL,
	`status` text DEFAULT 'unused' NOT NULL,
	`used_by_user_id` text,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cards_hash` ON `cards` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_cards_batch` ON `cards` (`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_cards_mask` ON `cards` (`code_mask`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`owner_id` text,
	`filename` text NOT NULL,
	`mime` text,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_files_app` ON `files` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_files_app_sha` ON `files` (`app_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`channel` text NOT NULL,
	`platform` text NOT NULL,
	`arch` text NOT NULL,
	`version` text NOT NULL,
	`file_id` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`notes_md` text,
	`mandatory` integer DEFAULT false NOT NULL,
	`min_version` text,
	`rollout_percent` integer DEFAULT 100 NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_releases_target` ON `releases` (`app_id`,`channel`,`platform`,`arch`,`version`);--> statement-breakpoint
CREATE INDEX `idx_releases_lookup` ON `releases` (`app_id`,`channel`,`platform`,`arch`);--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`uploader_id` text,
	`filename` text NOT NULL,
	`mime` text,
	`total_size` integer NOT NULL,
	`chunk_size` integer NOT NULL,
	`total_chunks` integer NOT NULL,
	`uploaded_chunks` text NOT NULL,
	`received_bytes` integer NOT NULL,
	`file_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_uploads_app` ON `upload_sessions` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_uploads_expires` ON `upload_sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `apps` ADD `quota_bytes` integer DEFAULT 5368709120 NOT NULL;