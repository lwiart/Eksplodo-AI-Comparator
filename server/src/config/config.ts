import { z } from 'zod';

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  appBaseUrl: string;
  databaseUrl: string;
  dataDir: string;
  cronSecret: string;
  smtp: { host: string; port: number; user: string; pass: string; from: string } | null;
  /** Premier administrateur créé au démarrage (e-mail normalisé) ; ne jamais journaliser le mot de passe. */
  bootstrapAdmin: { email: string; password: string } | null;
};

const MIN_PASSWORD_LENGTH = 12;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_BASE_URL: z.string().min(1, 'APP_BASE_URL est obligatoire').url('APP_BASE_URL doit être une URL valide'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est obligatoire'),
  DATA_DIR: z.string().min(1, 'DATA_DIR est obligatoire'),
  CRON_SECRET: z.string().min(32, 'CRON_SECRET doit contenir au moins 32 caractères'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
});

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  // Une variable vide (ex. copiée depuis .env.example) équivaut à une variable absente.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }

  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'configuration'} : ${i.message}`)
      .join('; ');
    throw new Error(`Configuration invalide — ${details}`);
  }
  const e = parsed.data;

  const smtpSet = SMTP_KEYS.filter((k) => e[k] !== undefined);
  let smtp: AppConfig['smtp'] = null;
  if (smtpSet.length > 0) {
    if (smtpSet.length !== SMTP_KEYS.length) {
      const missing = SMTP_KEYS.filter((k) => e[k] === undefined).join(', ');
      throw new Error(`Configuration invalide — SMTP incomplet : renseigner tous les champs ou aucun (manquant : ${missing})`);
    }
    smtp = { host: e.SMTP_HOST!, port: e.SMTP_PORT!, user: e.SMTP_USER!, pass: e.SMTP_PASS!, from: e.SMTP_FROM! };
  }

  // Les deux variables ou aucune.
  let bootstrapAdmin: AppConfig['bootstrapAdmin'] = null;
  const bootstrapEmail = e.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() || undefined;
  const bootstrapPassword = e.BOOTSTRAP_ADMIN_PASSWORD;
  if (bootstrapEmail !== undefined || bootstrapPassword !== undefined) {
    if (bootstrapEmail === undefined) {
      throw new Error('Configuration invalide — BOOTSTRAP_ADMIN_EMAIL est obligatoire avec BOOTSTRAP_ADMIN_PASSWORD');
    }
    if (bootstrapPassword === undefined) {
      throw new Error('Configuration invalide — BOOTSTRAP_ADMIN_PASSWORD est obligatoire avec BOOTSTRAP_ADMIN_EMAIL');
    }
    if (bootstrapPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Configuration invalide — BOOTSTRAP_ADMIN_PASSWORD doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères`,
      );
    }
    bootstrapAdmin = { email: bootstrapEmail, password: bootstrapPassword };
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    appBaseUrl: e.APP_BASE_URL.replace(/\/+$/, ''),
    databaseUrl: e.DATABASE_URL,
    dataDir: e.DATA_DIR,
    cronSecret: e.CRON_SECRET,
    smtp,
    bootstrapAdmin,
  };
}

/** Avertissements de démarrage (configuration acceptée mais probablement erronée). */
export function configWarnings(config: Pick<AppConfig, 'nodeEnv' | 'appBaseUrl'>): string[] {
  const warnings: string[] = [];
  if (config.appBaseUrl.startsWith('https:') && config.nodeEnv !== 'production') {
    warnings.push(
      `APP_BASE_URL est en HTTPS mais NODE_ENV vaut « ${config.nodeEnv} » : cookies non sécurisés et HSTS désactivé — NODE_ENV=production oublié ?`,
    );
  }
  return warnings;
}
