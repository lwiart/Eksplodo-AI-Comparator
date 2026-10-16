import { DateTime } from 'luxon';
import type { MailMessage } from './mailer.js';

export type MailBody = Omit<MailMessage, 'to'>;

const BRAND = '#003C58';
const ACCENT = '#BB450D';
const TEXT = '#4E6F7E';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Valeur sûre pour un objet d'e-mail : pas de retour à la ligne ni de caractère de contrôle, espaces normalisés. */
function subjectPart(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `paragraphs` doit déjà être du HTML sûr (les valeurs utilisateur y sont échappées par l'appelant). */
function layout(p: { title: string; paragraphs: string[]; extra?: string; button: string; link: string; footer: string }): string {
  const paras = p.paragraphs
    .map((t) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:${TEXT};">${t}</p>`)
    .join('');
  const link = escapeHtml(p.link);
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(p.title)}</title></head>
<body style="margin:0;padding:0;background:#F1F7F9;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F7F9;padding:24px 0;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border:1px solid #CEDEE6;">
<tr><td style="background:${BRAND};padding:20px 32px;color:#FFFFFF;font-size:20px;font-weight:bold;">Eksplodo · Comparateur IA</td></tr>
<tr><td style="padding:32px;">
<h1 style="margin:0 0 20px;font-size:22px;color:${BRAND};">${escapeHtml(p.title)}</h1>
${paras}${p.extra ?? ''}
<p style="margin:24px 0;"><a href="${link}" style="display:inline-block;background:${ACCENT};color:#FFFFFF;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:4px;">${escapeHtml(p.button)}</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:${TEXT};">Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :<br><a href="${link}" style="color:#0C659D;word-break:break-all;">${link}</a></p>
<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:${TEXT};">${escapeHtml(p.footer)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function invitationEmail(p: { name: string; link: string }): MailBody {
  const intro =
    'Vous avez été invité(e) à utiliser Eksplodo · Comparateur IA. Choisissez votre mot de passe pour activer votre compte. Ce lien est valable 72 heures.';
  const footer = "Si vous n'attendiez pas cette invitation, vous pouvez ignorer ce message.";
  return {
    // Objet propre à chaque personne : Gmail ne regroupe pas les invitations entre elles.
    subject: `${subjectPart(p.name)}, votre accès à Eksplodo · Comparateur IA`,
    text: `Bonjour ${p.name},

${intro}

Activer mon compte : ${p.link}

${footer}
`,
    html: layout({
      title: 'Bienvenue sur Eksplodo',
      paragraphs: [`Bonjour ${escapeHtml(p.name)},`, escapeHtml(intro)],
      button: 'Activer mon compte',
      link: p.link,
      footer,
    }),
  };
}

export function resetEmail(p: { name: string; link: string }): MailBody {
  const intro =
    "Une demande de réinitialisation de votre mot de passe a été effectuée. Ce lien est valable 24 heures et ne peut être utilisé qu'une seule fois.";
  const footer = "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.";
  return {
    subject: `${subjectPart(p.name)}, réinitialisation de votre mot de passe Eksplodo · Comparateur IA`,
    text: `Bonjour ${p.name},\n\n${intro}\n\nChoisir un nouveau mot de passe : ${p.link}\n\n${footer}\n`,
    html: layout({
      title: 'Réinitialisation du mot de passe',
      paragraphs: [`Bonjour ${escapeHtml(p.name)},`, escapeHtml(intro)],
      button: 'Choisir un nouveau mot de passe',
      link: p.link,
      footer,
    }),
  };
}

const ORIGIN_LABELS: Record<string, string> = {
  errors_purge: 'Purge du journal des erreurs',
  error_alert: "Alerte d'erreur par e-mail",
  error_digest: 'Récapitulatif des erreurs par e-mail',
  smtp: "Envoi d'e-mails (SMTP)",
};

/** Origine d'une erreur en clair : tâche ou service connu, sinon le texte tel quel (ex. `POST /api/x`). */
export function originLabel(origin: string): string {
  const [type, source] = origin.split(':', 2);
  const label = ORIGIN_LABELS[type!];
  if (label === undefined) return origin;
  return source ? `${label} (${source})` : label;
}

const MAX_MAIL_MESSAGE = 500;
const shortMessage = (m: string): string => (m.length > MAX_MAIL_MESSAGE ? `${m.slice(0, MAX_MAIL_MESSAGE)}…` : m);

/** Alerte immédiate d'une erreur grave : référence, origine, code, message masqué, occurrences et lien. Jamais de pile. */
export function errorAlertEmail(p: {
  reference: string;
  origin: string;
  code: string;
  message: string;
  occurrences: number;
  link: string;
}): MailBody {
  const origin = originLabel(p.origin);
  const message = shortMessage(p.message);
  const intro = `Une erreur grave est survenue (${origin}).`;
  const lines = [
    `Référence : ${p.reference}`,
    `Origine : ${origin}`,
    `Code : ${p.code}`,
    `Occurrences : ${p.occurrences}`,
    `Message : ${message}`,
  ];
  const footer = "Vous recevez ce message car les alertes d'erreurs immédiates sont activées (Administration, Journal des erreurs).";
  return {
    subject: `[Eksplodo · Comparateur IA] Erreur grave : ${subjectPart(origin)}`,
    text: `Bonjour,\n\n${intro}\n\n${lines.join('\n')}\n\nVoir le journal des erreurs : ${p.link}\n\n${footer}\n`,
    html: layout({
      title: 'Erreur grave',
      paragraphs: ['Bonjour,', escapeHtml(intro), ...lines.map(escapeHtml)],
      button: 'Voir le journal des erreurs',
      link: p.link,
      footer,
    }),
  };
}

export type ErrorDigestItem = {
  reference: string;
  severity: 'grave' | 'normale';
  origin: string;
  code: string;
  message: string;
  occurrences: number;
};

/** Récapitulatif quotidien des erreurs : comptes par gravité et par origine, les plus fréquentes, lien vers le journal. */
export function errorDigestEmail(p: {
  date: Date;
  bySeverity: { grave: number; normale: number };
  byOrigin: { origin: string; count: number }[];
  top: ErrorDigestItem[];
  link: string;
}): MailBody {
  const day = DateTime.fromJSDate(p.date, { zone: 'Europe/Paris' }).toFormat('dd/MM/yyyy');
  const total = p.bySeverity.grave + p.bySeverity.normale;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const intro = `${plural(total, 'erreur a été enregistrée', 'erreurs ont été enregistrées')} depuis le dernier récapitulatif : ${plural(p.bySeverity.grave, 'grave', 'graves')} et ${plural(p.bySeverity.normale, 'normale', 'normales')}.`;
  const originLines = p.byOrigin.map((o) => `${originLabel(o.origin)} : ${o.count}`);
  const topLines = p.top.map(
    (e) =>
      `${e.reference} - ${e.severity === 'grave' ? 'grave' : 'normale'} - ${originLabel(e.origin)} - ${e.code} - ${e.occurrences} ${e.occurrences === 1 ? 'occurrence' : 'occurrences'}\n  ${shortMessage(e.message)}`,
  );
  const footer = "Vous recevez ce récapitulatif car les notifications d'erreurs sont activées (Administration, Journal des erreurs).";
  const list = (items: string[]) =>
    `<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.5;color:${TEXT};">${items.map((i) => `<li style="margin:0 0 8px;">${i}</li>`).join('')}</ul>`;
  const extra =
    (originLines.length > 0
      ? `<h2 style="margin:24px 0 12px;font-size:18px;color:${BRAND};">Par origine</h2>${list(originLines.map(escapeHtml))}`
      : '') +
    (topLines.length > 0
      ? `<h2 style="margin:24px 0 12px;font-size:18px;color:${BRAND};">Les plus fréquentes</h2>${list(
          p.top.map(
            (e) =>
              `<strong>${escapeHtml(e.reference)}</strong> - ${e.severity === 'grave' ? 'grave' : 'normale'} - ${escapeHtml(originLabel(e.origin))} - ${escapeHtml(e.code)} - ${e.occurrences} ${e.occurrences === 1 ? 'occurrence' : 'occurrences'}<br>${escapeHtml(shortMessage(e.message))}`,
          ),
        )}`
      : '');
  return {
    subject: `[Eksplodo · Comparateur IA] Récapitulatif des erreurs du ${day}`,
    text: `Bonjour,\n\n${intro}\n\nPar origine\n${originLines.map((l) => `- ${l}`).join('\n')}\n\nLes plus fréquentes\n${topLines.map((l) => `- ${l}`).join('\n')}\n\nVoir le journal des erreurs : ${p.link}\n\n${footer}\n`,
    html: layout({
      title: `Récapitulatif des erreurs du ${day}`,
      paragraphs: ['Bonjour,', escapeHtml(intro)],
      extra,
      button: 'Voir le journal des erreurs',
      link: p.link,
      footer,
    }),
  };
}
