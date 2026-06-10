CREATE TABLE `source_health` (
	`source` text PRIMARY KEY NOT NULL,
	`ok_count` integer DEFAULT 0 NOT NULL,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`consecutive_fails` integer DEFAULT 0 NOT NULL,
	`last_ok_at` integer,
	`last_error_at` integer,
	`last_error` text
);
