-- User-owned games: every game/analysis/sync row belongs to a user_id.
-- Old rows had no owner (test data) so the tables are rebuilt empty.
-- The linked chess.com / lichess handles move onto the user profile.
DROP TABLE IF EXISTS `game_analyses`;
--> statement-breakpoint
DROP TABLE IF EXISTS `games`;
--> statement-breakpoint
DROP TABLE IF EXISTS `sync_state`;
--> statement-breakpoint
ALTER TABLE `user` ADD `chesscom_username` text;
--> statement-breakpoint
ALTER TABLE `user` ADD `lichess_username` text;
--> statement-breakpoint
CREATE TABLE `games` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`chess_handle` text,
	`opponent` text NOT NULL,
	`result` text NOT NULL,
	`time_control` text NOT NULL,
	`time_class` text,
	`date` integer NOT NULL,
	`source` text DEFAULT 'chesscom' NOT NULL,
	`pgn` text,
	`chesscom_white_accuracy` real,
	`chesscom_black_accuracy` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `game_analyses` (
	`user_id` text NOT NULL,
	`game_id` text NOT NULL,
	`accuracy` real NOT NULL,
	`user_color` text,
	`depth` integer NOT NULL,
	`evals` text NOT NULL,
	`notes` text,
	`takeaways` text,
	`summary` text,
	`analyzed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `game_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`chess_handle` text,
	`last_synced_at` integer NOT NULL,
	`games_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
