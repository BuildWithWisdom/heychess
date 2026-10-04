CREATE TABLE `game_analyses` (
	`game_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`accuracy` real NOT NULL,
	`user_color` text,
	`depth` integer NOT NULL,
	`evals` text NOT NULL,
	`notes` text,
	`takeaways` text,
	`summary` text,
	`analyzed_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`username` text PRIMARY KEY NOT NULL,
	`last_synced_at` integer NOT NULL,
	`games_count` integer DEFAULT 0 NOT NULL
);
