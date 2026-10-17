import { z } from 'zod';
import { ValidationError } from '../../errors.js';

export type ScoringMethod = 'judge' | 'expected' | 'manual';

const exactConfig = z.strictObject({
  mode: z.literal('exact'),
  expected: z.string().min(1).max(50_000),
  ignoreCase: z.boolean().default(true),
  ignoreAccents: z.boolean().default(false),
});
const containsConfig = z.strictObject({
  mode: z.literal('contains'),
  items: z.array(z.string().min(1).max(1_000)).min(1).max(50),
  ignoreCase: z.boolean().default(true),
});
const regexConfig = z
  .strictObject({
    mode: z.literal('regex'),
    pattern: z.string().min(1).max(2_000),
    flags: z.string().regex(/^[gimsuy]*$/, 'drapeau invalide (gimsuy seulement)').default(''),
  })
  .refine(
    (c) => {
      try {
        new RegExp(c.pattern, c.flags);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Expression régulière invalide', path: ['pattern'] },
  );
const judgeConfig = z.strictObject({
  criteria: z.string().min(1).max(5_000),
  reference: z.string().max(50_000).optional(),
});
const manualConfig = z.strictObject({});

const expectedConfig = z.discriminatedUnion('mode', [exactConfig, containsConfig, regexConfig]);

export type ExpectedConfig = z.output<typeof exactConfig> | z.output<typeof containsConfig> | z.output<typeof regexConfig>;
export type JudgeConfig = z.output<typeof judgeConfig>;
export type ScoringConfig = ExpectedConfig | JudgeConfig | Record<string, never>;

/** Schéma Zod de la configuration de notation propre à la méthode. */
export function scoringConfigSchema(method: ScoringMethod): z.ZodType<ScoringConfig> {
  if (method === 'expected') return expectedConfig as z.ZodType<ScoringConfig>;
  if (method === 'judge') return judgeConfig;
  return manualConfig as z.ZodType<ScoringConfig>;
}

/** Valide et normalise (valeurs par défaut) ; lève une `ValidationError` (`validation`) en français. */
export function parseScoringConfig(method: ScoringMethod, raw: unknown): ScoringConfig {
  const result = scoringConfigSchema(method).safeParse(raw);
  if (result.success) return result.data;
  const message = result.error.issues
    .map((i) => `${['scoringConfig', ...i.path].join('.')} : ${i.message}`)
    .join('; ');
  throw new ValidationError('validation', message);
}
