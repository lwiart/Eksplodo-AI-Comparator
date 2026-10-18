// Lecture stricte de la réponse du juge : objets JSON équilibrés, le dernier validé par Zod l'emporte.
import { z } from 'zod';

const RATIONALE_MAX = 2_000;

const replySchema = z.object({
  score: z.number().finite().min(0).max(100),
  rationale: z.string().trim().min(1),
});

export type JudgeReply = { ok: true; score: number; rationale: string } | { ok: false; reason: string };

type Candidate = { start: number; end: number; raw: string };

/** Objets `{…}` équilibrés du texte, un par accolade ouvrante ; les accolades à l'intérieur des chaînes JSON sont ignorées. */
function balancedObjects(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        out.push({ start, end: i + 1, raw: text.slice(start, i + 1) });
        break;
      }
    }
  }
  return out;
}

/**
 * Verdict du juge : chaque objet équilibré est essayé, du dernier terminé au premier (à fin égale, le plus englobant) ; le
 * premier qui passe le schéma l'emporte. Un juge qui cite la réponse évaluée (où un modèle aurait glissé un faux
 * `{"score": 100, …}`) avant de rendre son verdict est donc noté sur son verdict, non sur la citation.
 */
export function parseJudgeReply(text: string): JudgeReply {
  const candidates = balancedObjects(text).sort((a, b) => b.end - a.end || a.start - b.start);
  if (candidates.length === 0) return { ok: false, reason: 'Aucun objet JSON dans la réponse du juge' };
  let schemaFailure: string | null = null;
  for (const { raw } of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const parsed = replySchema.safeParse(json);
    if (!parsed.success) {
      schemaFailure ??= parsed.error.issues.map((i) => `${i.path.join('.') || 'racine'} : ${i.message}`).join('; ');
      continue;
    }
    return {
      ok: true,
      score: Math.round(parsed.data.score),
      rationale: parsed.data.rationale.slice(0, RATIONALE_MAX),
    };
  }
  return schemaFailure === null
    ? { ok: false, reason: 'JSON invalide dans la réponse du juge' }
    : { ok: false, reason: `Réponse du juge invalide (${schemaFailure})` };
}
