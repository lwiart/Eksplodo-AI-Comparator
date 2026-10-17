CREATE TABLE `share_links` (
	`id` char(36) NOT NULL,
	`run_id` char(36) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`title` varchar(120) NOT NULL,
	`intro` text,
	`verdicts` json NOT NULL,
	`show_costs` boolean NOT NULL DEFAULT false,
	`show_responses` boolean NOT NULL DEFAULT false,
	`active` boolean NOT NULL DEFAULT true,
	`view_count` int NOT NULL DEFAULT 0,
	`created_by` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `share_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `share_links_token_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `share_links` ADD CONSTRAINT `share_links_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `share_links` ADD CONSTRAINT `share_links_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `share_links_run_idx` ON `share_links` (`run_id`);