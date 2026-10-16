import nodemailer from 'nodemailer';
import type { AppConfig } from '../../config/config.js';

export type MailMessage = { to: string; subject: string; text: string; html: string };
export interface Mailer {
  /**
   * `false` : les messages ne partent pas (journal de production, sans SMTP). Les envois « consommables » (récapitulatif,
   * alerte de source) ne doivent alors rien marquer comme envoyé. Le journal de développement compte comme un envoi
   * (le texte est lisible dans la console).
   */
  readonly delivers: boolean;
  send(msg: MailMessage): Promise<void>;
}

/** Options du transport SMTP : délais finis (un serveur muet ne bloque ni une requête ni le démarrage), TLS exigé. */
export function smtpTransportOptions(smtp: NonNullable<AppConfig['smtp']>) {
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465, // 465 : TLS implicite
    requireTLS: smtp.port !== 465, // autres ports : STARTTLS obligatoire (jamais d'identifiants en clair)
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

export function createSmtpMailer(smtp: NonNullable<AppConfig['smtp']>): Mailer {
  const transport = nodemailer.createTransport(smtpTransportOptions(smtp));
  return {
    delivers: true,
    async send(msg) {
      await transport.sendMail({ from: smtp.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    },
  };
}

export function createFakeMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    delivers: true,
    sent,
    async send(msg) {
      sent.push(msg);
    },
  };
}

type LogFn = (obj: object, msg: string) => void;

/** Sans SMTP : journalise l'e-mail. Le texte (lien inclus) n'est journalisé que hors production ; en production : destinataire et objet, en `warn`. */
export function createLogMailer(logger: { info: LogFn; warn: LogFn }, production = false): Mailer {
  return {
    delivers: !production,
    async send(msg) {
      const note = 'SMTP non configuré : e-mail non envoyé';
      // En production, jamais de lien (jeton actif) dans les journaux.
      if (production) logger.warn({ to: msg.to, subject: msg.subject }, note);
      else logger.info({ to: msg.to, subject: msg.subject, text: msg.text }, note);
    },
  };
}
