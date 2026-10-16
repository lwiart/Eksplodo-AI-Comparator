CREATE TABLE `audit_log` (
	`id` char(36) NOT NULL,
	`actor_user_id` char(36),
	`action` varchar(100) NOT NULL,
	`target_type` varchar(50) NOT NULL,
	`target_id` varchar(36),
	`details` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`purpose` enum('invite','reset') NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `invitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `invitations_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` char(64) NOT NULL,
	`user_id` char(36) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`ip` varchar(64) NOT NULL,
	`user_agent` varchar(400) NOT NULL,
	CONSTRAINT `sessions_id_hash` PRIMARY KEY(`id_hash`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` varchar(100) NOT NULL,
	`value` json NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(36) NOT NULL,
	`email` varchar(320) NOT NULL,
	`name` varchar(200) NOT NULL,
	`password_hash` varchar(255),
	`role` enum('admin','user') NOT NULL,
	`status` enum('invited','active','disabled') NOT NULL DEFAULT 'invited',
	`failed_login_count` int NOT NULL DEFAULT 0,
	`locked_until` datetime(3),
	`last_login_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` char(36) NOT NULL,
	`type` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`status` enum('queued','running','done','failed') NOT NULL DEFAULT 'queued',
	`attempts` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL DEFAULT 4,
	`run_after` datetime(3) NOT NULL,
	`locked_at` datetime(3),
	`locked_by` varchar(64),
	`progress` json,
	`error` text,
	`dedupe_key` varchar(191),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `jobs_dedupe_key_unique` UNIQUE(`dedupe_key`)
);
--> statement-breakpoint
CREATE TABLE `error_events` (
	`id` char(36) NOT NULL,
	`reference` char(7) NOT NULL,
	`severity` enum('grave','normale') NOT NULL,
	`source` enum('request','job','external','mail') NOT NULL,
	`origin` varchar(200) NOT NULL,
	`code` varchar(100) NOT NULL,
	`http_status` int,
	`message` text NOT NULL,
	`stack` text,
	`user_id` char(36),
	`target_type` varchar(30),
	`target_id` char(36),
	`fingerprint` char(64) NOT NULL,
	`occurrences` int NOT NULL DEFAULT 1,
	`first_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`resolved_at` datetime(3),
	`resolved_by` char(36),
	`notified_at` datetime(3),
	CONSTRAINT `error_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `error_events_reference_uq` UNIQUE(`reference`)
);
--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `jobs_status_run_after_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `jobs_type_created_at_idx` ON `jobs` (`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `error_events_last_seen_idx` ON `error_events` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `error_events_severity_last_seen_idx` ON `error_events` (`severity`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `error_events_fingerprint_last_seen_idx` ON `error_events` (`fingerprint`,`last_seen_at`);