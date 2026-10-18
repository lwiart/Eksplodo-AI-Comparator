-- Notes sur 100 : colonnes élargies (decimal(4,2) plafonne à 99,99), valeurs d'origine sauvegardées, puis multipliées par 10.
-- Rejouable sans effet de bord : la conversion repart toujours des valeurs sauvegardées (jamais de ×100).
ALTER TABLE `results` MODIFY COLUMN `auto_score` decimal(5,2);--> statement-breakpoint
ALTER TABLE `results` MODIFY COLUMN `override_score` decimal(5,2);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `score_backup_results_0007` (
	`id` char(36) NOT NULL,
	`auto_score` decimal(4,2),
	`override_score` decimal(4,2),
	CONSTRAINT `score_backup_results_0007_id` PRIMARY KEY(`id`)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `score_backup_manual_0007` (
	`id` char(36) NOT NULL,
	`score` int NOT NULL,
	CONSTRAINT `score_backup_manual_0007_id` PRIMARY KEY(`id`)
);--> statement-breakpoint
INSERT IGNORE INTO `score_backup_results_0007` (`id`, `auto_score`, `override_score`)
	SELECT `id`, `auto_score`, `override_score` FROM `results` WHERE `auto_score` IS NOT NULL OR `override_score` IS NOT NULL;--> statement-breakpoint
INSERT IGNORE INTO `score_backup_manual_0007` (`id`, `score`) SELECT `id`, `score` FROM `manual_scores`;--> statement-breakpoint
UPDATE `results` r INNER JOIN `score_backup_results_0007` b ON b.`id` = r.`id`
	SET r.`auto_score` = b.`auto_score` * 10, r.`override_score` = b.`override_score` * 10;--> statement-breakpoint
UPDATE `manual_scores` m INNER JOIN `score_backup_manual_0007` b ON b.`id` = m.`id` SET m.`score` = b.`score` * 10;
