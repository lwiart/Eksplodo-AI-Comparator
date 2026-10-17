/** Montant arrondi au micro-dollar (précision de `DECIMAL(12,6)`) : résultat, série et `ai_usage` concordent. */
export const roundUsd = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;
