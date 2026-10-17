// Crochet `onResultFinished` du moteur : oriente un résultat terminé vers sa méthode de notation.
import type { Db } from '../../db/client.js';
import { applyExpectedScore } from './expected.js';

/** Les notes du juge (file d'attente) seront ajoutées ici ; la méthode manuelle n'a rien à faire à ce stade. */
export function createOnResultFinished(deps: { db: Db }): (resultId: string) => Promise<void> {
  return async (resultId) => {
    await applyExpectedScore(deps.db, resultId);
  };
}
