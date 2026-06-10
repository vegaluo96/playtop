CREATE TABLE `audit_hashes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`hash_value` text NOT NULL,
	`previous_hash` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ah_entity_idx` ON `audit_hashes` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `data_provider_health` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`checked_at` integer NOT NULL,
	`latency_ms` integer,
	`missing_rate` real,
	`error_rate` real,
	`abnormal_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`health_score` real,
	`details_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dph_provider_time_idx` ON `data_provider_health` (`provider_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `match_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`snapshot_type` text NOT NULL,
	`captured_at` integer NOT NULL,
	`kickoff_at` integer NOT NULL,
	`team_state_json` text,
	`lineup_json` text,
	`injury_json` text,
	`weather_json` text,
	`standings_json` text,
	`stats_json` text,
	`provider_health_json` text,
	`snapshot_hash` text NOT NULL,
	`previous_snapshot_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ms_match_idx` ON `match_snapshots` (`match_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `model_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`snapshot_id` integer,
	`model_version` text NOT NULL,
	`input_json` text NOT NULL,
	`input_hash` text NOT NULL,
	`output_json` text NOT NULL,
	`output_hash` text NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `match_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mr_match_idx` ON `model_runs` (`match_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `odds_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`provider_id` integer,
	`bookmaker_name` text NOT NULL,
	`market_type` text NOT NULL,
	`line` real,
	`selection` text NOT NULL,
	`odds_decimal` real NOT NULL,
	`implied_probability` real NOT NULL,
	`normalized_probability` real,
	`captured_at` integer NOT NULL,
	`is_stale` integer DEFAULT 0 NOT NULL,
	`odds_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `os_match_time_idx` ON `odds_snapshots` (`match_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `provider_entity_map` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`provider_entity_id` text NOT NULL,
	`playtop_entity_id` integer NOT NULL,
	`confidence_score` real DEFAULT 1 NOT NULL,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pem_uq` ON `provider_entity_map` (`provider_id`,`entity_type`,`provider_entity_id`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_name_unique` ON `providers` (`name`);--> statement-breakpoint
CREATE TABLE `raw_api_payloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer,
	`endpoint` text NOT NULL,
	`request_params_json` text,
	`response_json` text,
	`http_status` integer,
	`fetched_at` integer NOT NULL,
	`response_hash` text,
	`error_message` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rap_endpoint_time_idx` ON `raw_api_payloads` (`endpoint`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `report_locks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`final_snapshot_id` integer,
	`final_model_run_id` integer,
	`final_report_version_id` integer,
	`locked_at` integer NOT NULL,
	`lock_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`final_snapshot_id`) REFERENCES `match_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`final_model_run_id`) REFERENCES `model_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`final_report_version_id`) REFERENCES `report_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_locks_match_id_unique` ON `report_locks` (`match_id`);--> statement-breakpoint
CREATE TABLE `report_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`snapshot_id` integer,
	`model_run_id` integer,
	`version_type` text NOT NULL,
	`title` text NOT NULL,
	`free_preview` text NOT NULL,
	`paid_content` text NOT NULL,
	`summary_json` text NOT NULL,
	`numbers_whitelist_json` text,
	`report_hash` text NOT NULL,
	`previous_report_hash` text,
	`is_public` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `match_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_run_id`) REFERENCES `model_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rv_match_idx` ON `report_versions` (`match_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`report_lock_id` integer,
	`final_result_json` text NOT NULL,
	`opinion_json` text NOT NULL,
	`settlement_result` text NOT NULL,
	`roi` real,
	`clv` real,
	`brier_score` real,
	`settled_at` integer NOT NULL,
	`settlement_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_lock_id`) REFERENCES `report_locks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `st_match_idx` ON `settlements` (`match_id`);--> statement-breakpoint
CREATE TABLE `track_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope_type` text NOT NULL,
	`scope_key` text NOT NULL,
	`total_matches` integer DEFAULT 0 NOT NULL,
	`published_opinions` integer DEFAULT 0 NOT NULL,
	`watch_only_count` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`pushes` integer DEFAULT 0 NOT NULL,
	`roi` real,
	`clv` real,
	`max_drawdown` real,
	`brier_score` real,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tr_scope_uq` ON `track_records` (`scope_type`,`scope_key`);