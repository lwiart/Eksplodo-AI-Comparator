-- Statut « tronquée » : réponse vide, la réflexion du modèle a épuisé la limite de tokens avant tout texte.
ALTER TABLE `results` MODIFY COLUMN `status` enum('pending','running','done','error','timeout','unsupported','truncated') NOT NULL;--> statement-breakpoint
-- Requalification des réponses déjà enregistrées comme réussies : texte vide, et fin signalée par la limite ou tokens
-- consommés (sortie + réflexion) au niveau de la limite du test. Leur note (souvent 0) est retirée : elles ne comptent
-- plus dans la qualité ni dans la fiabilité, et « Relancer les erreurs » peut les rejouer. Rejouable sans effet de bord.
UPDATE `results` r INNER JOIN `run_tests` rt ON rt.`id` = r.`run_test_id`
	SET r.`status` = 'truncated',
		r.`response_text` = NULL,
		r.`auto_score` = NULL,
		r.`judge_rationale` = NULL,
		r.`score_status` = 'pending',
		r.`error_code` = 'truncated',
		r.`error_message` = CONCAT(
			'Aucun texte : la limite de ',
			CAST(JSON_VALUE(rt.`snapshot`, '$.maxTokens') AS UNSIGNED),
			' tokens a été atteinte pendant la réflexion, avant la réponse.'
		)
	WHERE r.`status` = 'done'
		AND TRIM(COALESCE(r.`response_text`, '')) = ''
		AND (
			r.`finish_reason` = 'length'
			OR COALESCE(r.`output_tokens`, 0) + COALESCE(r.`reasoning_tokens`, 0)
				>= 0.98 * CAST(JSON_VALUE(rt.`snapshot`, '$.maxTokens') AS UNSIGNED)
		);
