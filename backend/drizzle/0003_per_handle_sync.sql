-- Sync freshness is tracked per linked account now: each chess handle
-- keeps its own library, so each needs its own "last synced" row.
-- sync_state holds ephemeral timestamps only, so the table is rebuilt empty.
DROP TABLE IF EXISTS `sync_state`;
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`user_id` text NOT NULL,
	`chess_handle` text NOT NULL,
	`last_synced_at` integer NOT NULL,
	`games_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `chess_handle`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
