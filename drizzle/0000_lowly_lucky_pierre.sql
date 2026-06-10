CREATE TABLE `analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`model_version` text NOT NULL,
	`engine_output` text NOT NULL,
	`report_md` text NOT NULL,
	`llm_sections` text,
	`input_snapshot_ids` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`content_hash` text,
	`prev_hash` text,
	`published_at` integer,
	`public_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `analyses_match_idx` ON `analyses` (`match_id`);--> statement-breakpoint
CREATE INDEX `analyses_status_idx` ON `analyses` (`status`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` integer,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_time_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `data_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`payload` text NOT NULL,
	`content_hash` text NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `snap_match_kind_time_idx` ON `data_snapshots` (`match_id`,`kind`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `fetch_cache` (
	`url` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `history_matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` integer NOT NULL,
	`season` text,
	`played_at` integer NOT NULL,
	`home_team_id` integer NOT NULL,
	`away_team_id` integer NOT NULL,
	`home_goals` integer NOT NULL,
	`away_goals` integer NOT NULL,
	`ht_home` integer,
	`ht_away` integer,
	`neutral` integer DEFAULT 0 NOT NULL,
	`stats` text,
	`closing_odds` text,
	`referee` text,
	`dedup_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`home_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`away_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hm_dedup_uq` ON `history_matches` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `hm_league_time_idx` ON `history_matches` (`league_id`,`played_at`);--> statement-breakpoint
CREATE INDEX `hm_home_idx` ON `history_matches` (`home_team_id`,`played_at`);--> statement-breakpoint
CREATE INDEX `hm_away_idx` ON `history_matches` (`away_team_id`,`played_at`);--> statement-breakpoint
CREATE TABLE `leagues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`country` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leagues_code_uq` ON `leagues` (`code`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ext_id` text,
	`league_id` integer NOT NULL,
	`home_team_id` integer NOT NULL,
	`away_team_id` integer NOT NULL,
	`kickoff_at` integer NOT NULL,
	`venue` text,
	`venue_lat` real,
	`venue_lon` real,
	`neutral` integer DEFAULT 0 NOT NULL,
	`round` text,
	`source` text NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`price_points` integer,
	`final_analysis_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`home_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`away_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `matches_ext_uq` ON `matches` (`ext_id`);--> statement-breakpoint
CREATE INDEX `matches_kickoff_idx` ON `matches` (`kickoff_at`);--> statement-breakpoint
CREATE INDEX `matches_status_idx` ON `matches` (`status`);--> statement-breakpoint
CREATE TABLE `outcomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`home_goals` integer NOT NULL,
	`away_goals` integer NOT NULL,
	`ht_home` integer,
	`ht_away` integer,
	`final_status` text DEFAULT 'finished' NOT NULL,
	`source` text NOT NULL,
	`provisional` integer DEFAULT 0 NOT NULL,
	`recorded_by` integer,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outcomes_match_uq` ON `outcomes` (`match_id`);--> statement-breakpoint
CREATE TABLE `point_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`delta` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`type` text NOT NULL,
	`ref_match_id` integer,
	`note` text,
	`admin_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ptx_user_time_idx` ON `point_transactions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `predictions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_id` integer NOT NULL,
	`match_id` integer NOT NULL,
	`market` text NOT NULL,
	`selection` text NOT NULL,
	`line` real,
	`model_prob` real NOT NULL,
	`odds_at_publish` real,
	`closing_odds` real,
	`ev` real,
	`kelly` real,
	`result` text DEFAULT 'pending' NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pred_market_result_idx` ON `predictions` (`market`,`result`);--> statement-breakpoint
CREATE INDEX `pred_settled_idx` ON `predictions` (`settled_at`);--> statement-breakpoint
CREATE INDEX `pred_analysis_idx` ON `predictions` (`analysis_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `team_ratings` (
	`team_id` integer PRIMARY KEY NOT NULL,
	`elo` real DEFAULT 1500 NOT NULL,
	`matches_played` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`country` text,
	`aliases` text DEFAULT '[]' NOT NULL,
	`home_venue` text,
	`venue_lat` real,
	`venue_lon` real,
	`logo_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_country_name_uq` ON `teams` (`country`,`name`);--> statement-breakpoint
CREATE TABLE `unlocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`match_id` integer NOT NULL,
	`points_spent` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unlocks_user_match_uq` ON `unlocks` (`user_id`,`match_id`);--> statement-breakpoint
CREATE INDEX `unlocks_match_idx` ON `unlocks` (`match_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_uq` ON `users` (`username`);