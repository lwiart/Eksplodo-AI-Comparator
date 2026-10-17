CREATE TABLE `suite_tests` (
	`suite_id` char(36) NOT NULL,
	`test_id` char(36) NOT NULL,
	`position` int NOT NULL,
	CONSTRAINT `suite_tests_suite_id_test_id_pk` PRIMARY KEY(`suite_id`,`test_id`)
);
--> statement-breakpoint
CREATE TABLE `suites` (
	`id` char(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `suites_id` PRIMARY KEY(`id`),
	CONSTRAINT `suites_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `test_attachments` (
	`id` char(36) NOT NULL,
	`test_id` char(36) NOT NULL,
	`original_name` varchar(255) NOT NULL,
	`mime` enum('image/png','image/jpeg','image/webp','application/pdf') NOT NULL,
	`size` int NOT NULL,
	`storage_path` varchar(500) NOT NULL,
	`sha256` char(64) NOT NULL,
	`pages` int,
	`deleted_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `test_attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tests` (
	`id` char(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`category` varchar(100) NOT NULL,
	`tags` json NOT NULL,
	`system_prompt` mediumtext,
	`user_prompt` mediumtext NOT NULL,
	`temperature` decimal(3,2) NOT NULL DEFAULT 0.2,
	`max_tokens` int NOT NULL DEFAULT 1000,
	`scoring_method` enum('judge','expected','manual') NOT NULL,
	`scoring_config` json NOT NULL,
	`archived_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` char(36) NOT NULL,
	`origin` enum('run','judge','quick_try') NOT NULL,
	`run_id` char(36),
	`model_id` char(36) NOT NULL,
	`input_tokens` int NOT NULL,
	`output_tokens` int NOT NULL,
	`reasoning_tokens` int NOT NULL,
	`cost_usd` decimal(12,6) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ai_usage_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `results` (
	`id` char(36) NOT NULL,
	`run_id` char(36) NOT NULL,
	`run_test_id` char(36) NOT NULL,
	`model_id` char(36) NOT NULL,
	`repetition` int NOT NULL,
	`status` enum('pending','running','done','error','timeout','unsupported') NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`response_text` mediumtext,
	`finish_reason` varchar(20),
	`input_tokens` int,
	`output_tokens` int,
	`reasoning_tokens` int,
	`tokens_estimated` boolean NOT NULL DEFAULT false,
	`ttft_ms` int,
	`total_ms` int,
	`tokens_per_s` decimal(10,2),
	`cost_usd` decimal(12,6),
	`cost_source` enum('computed','provider'),
	`error_code` varchar(50),
	`error_message` text,
	`score_status` enum('pending','done','awaiting_manual','judge_failed') NOT NULL DEFAULT 'pending',
	`auto_score` decimal(4,2),
	`judge_rationale` text,
	`judge_cost_usd` decimal(12,6),
	`override_score` decimal(4,2),
	`override_by` char(36),
	`started_at` datetime(3),
	`completed_at` datetime(3),
	CONSTRAINT `results_id` PRIMARY KEY(`id`),
	CONSTRAINT `results_run_test_model_rep_uq` UNIQUE(`run_id`,`run_test_id`,`model_id`,`repetition`)
);
--> statement-breakpoint
CREATE TABLE `run_models` (
	`run_id` char(36) NOT NULL,
	`model_id` char(36) NOT NULL,
	`added_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `run_models_run_id_model_id_pk` PRIMARY KEY(`run_id`,`model_id`)
);
--> statement-breakpoint
CREATE TABLE `run_tests` (
	`id` char(36) NOT NULL,
	`run_id` char(36) NOT NULL,
	`test_id` char(36) NOT NULL,
	`position` int NOT NULL,
	`snapshot` json NOT NULL,
	CONSTRAINT `run_tests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` char(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`suite_id` char(36),
	`judge_model_id` char(36),
	`repetitions` int NOT NULL,
	`concurrency` int NOT NULL,
	`budget_usd` decimal(10,4),
	`status` enum('queued','running','paused','completed','interrupted') NOT NULL,
	`pause_reason` enum('user','budget'),
	`models_cost_usd` decimal(12,6) NOT NULL DEFAULT 0,
	`judge_cost_usd` decimal(12,6) NOT NULL DEFAULT 0,
	`weights` json NOT NULL,
	`active_job_id` char(36),
	`created_by` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`started_at` datetime(3),
	`completed_at` datetime(3),
	CONSTRAINT `runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `suite_tests` ADD CONSTRAINT `suite_tests_suite_id_suites_id_fk` FOREIGN KEY (`suite_id`) REFERENCES `suites`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `suite_tests` ADD CONSTRAINT `suite_tests_test_id_tests_id_fk` FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `test_attachments` ADD CONSTRAINT `test_attachments_test_id_tests_id_fk` FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD CONSTRAINT `ai_usage_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD CONSTRAINT `ai_usage_model_id_models_id_fk` FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `results` ADD CONSTRAINT `results_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `results` ADD CONSTRAINT `results_run_test_id_run_tests_id_fk` FOREIGN KEY (`run_test_id`) REFERENCES `run_tests`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `results` ADD CONSTRAINT `results_model_id_models_id_fk` FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_models` ADD CONSTRAINT `run_models_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_models` ADD CONSTRAINT `run_models_model_id_models_id_fk` FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_tests` ADD CONSTRAINT `run_tests_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_tests` ADD CONSTRAINT `run_tests_test_id_tests_id_fk` FOREIGN KEY (`test_id`) REFERENCES `tests`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `runs_suite_id_suites_id_fk` FOREIGN KEY (`suite_id`) REFERENCES `suites`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `runs_judge_model_id_models_id_fk` FOREIGN KEY (`judge_model_id`) REFERENCES `models`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `runs_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `tests_category_idx` ON `tests` (`category`);--> statement-breakpoint
CREATE INDEX `ai_usage_created_idx` ON `ai_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `results_run_status_idx` ON `results` (`run_id`,`status`);