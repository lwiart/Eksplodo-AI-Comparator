CREATE TABLE `manual_scores` (
	`id` char(36) NOT NULL,
	`result_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`score` int NOT NULL,
	`comment` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `manual_scores_id` PRIMARY KEY(`id`),
	CONSTRAINT `manual_scores_result_user_uq` UNIQUE(`result_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `manual_scores` ADD CONSTRAINT `manual_scores_result_id_results_id_fk` FOREIGN KEY (`result_id`) REFERENCES `results`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `manual_scores` ADD CONSTRAINT `manual_scores_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `manual_scores_result_idx` ON `manual_scores` (`result_id`);