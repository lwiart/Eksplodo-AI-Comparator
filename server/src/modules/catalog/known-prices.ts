// Prix connus préremplis à la découverte des modèles ($ par million de tokens, vérifiés le 2026-10-17).
export const KNOWN_PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
