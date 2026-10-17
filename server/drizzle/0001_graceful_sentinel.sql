CREATE TABLE `models` (
	`id` char(36) NOT NULL,
	`provider_id` char(36) NOT NULL,
	`api_model_id` varchar(200) NOT NULL,
	`display_name` varchar(200) NOT NULL,
	`color` char(7) NOT NULL,
	`input_price_per_m` decimal(10,4) NOT NULL DEFAULT 0,
	`output_price_per_m` decimal(10,4) NOT NULL DEFAULT 0,
	`price_source` enum('manual','openrouter') NOT NULL DEFAULT 'manual',
	`supports_vision` boolean NOT NULL DEFAULT false,
	`supports_pdf` boolean NOT NULL DEFAULT false,
	`context_window` int,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `models_id` PRIMARY KEY(`id`),
	CONSTRAINT `models_provider_api_model_uq` UNIQUE(`provider_id`,`api_model_id`)
);
--> statement-breakpoint
CREATE TABLE `openrouter_catalog` (
	`id` char(36) NOT NULL,
	`openrouter_id` varchar(200) NOT NULL,
	`name` varchar(300) NOT NULL,
	`input_price_per_m` decimal(10,4),
	`output_price_per_m` decimal(10,4),
	`input_modalities` json NOT NULL,
	`context_window` int,
	`initial_sync` boolean NOT NULL DEFAULT false,
	`first_seen_at` datetime(3) NOT NULL,
	`last_seen_at` datetime(3) NOT NULL,
	`dismissed_at` datetime(3),
	CONSTRAINT `openrouter_catalog_id` PRIMARY KEY(`id`),
	CONSTRAINT `openrouter_catalog_openrouter_id_unique` UNIQUE(`openrouter_id`)
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` char(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`type` enum('openai_compatible','anthropic','google') NOT NULL,
	`base_url` varchar(500) NOT NULL,
	`api_key_encrypted` text,
	`api_key_last4` varchar(4),
	`max_concurrency` int NOT NULL DEFAULT 2,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `providers_id` PRIMARY KEY(`id`),
	CONSTRAINT `providers_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
ALTER TABLE `models` ADD CONSTRAINT `models_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `openrouter_catalog_first_seen_idx` ON `openrouter_catalog` (`first_seen_at`);