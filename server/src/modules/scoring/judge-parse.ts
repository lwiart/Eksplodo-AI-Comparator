// Lecture stricte de la réponse du juge : premier objet JSON équilibré, validé par Zod.
import { z } from 'zod';

const RATIONALE_MAX = 2_000;

const replySchema = z.object({
  score: z.number().finite().min(0).max(10),
  rationale: z.string().trim().min(1),
});

export type JudgeReply = { ok: true; score: number; rationale: string } | { ok: false; reason: string };

/** Premier objet `{…}` équilibré du texte ; les accolades à l'intérieur des chaînes JSON sont ignorées. */
function firstBalancedObject(text: string): string | null {
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
      else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJudgeReply(text: string): JudgeReply {
  const raw = firstBalancedObject(text);
  if (raw === null) return { ok: false, reason: 'Aucun objet JSON dans la réponse du juge' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'JSON invalide dans la réponse du juge' };
  }
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'racine'} : ${i.message}`).join('; ');
    return { ok: false, reason: `Réponse du juge invalide (${detail})` };
  }
  return {
    ok: true,
    score: Math.round(parsed.data.score * 10) / 10,
    rationale: parsed.data.rationale.slice(0, RATIONALE_MAX),
  };
}
