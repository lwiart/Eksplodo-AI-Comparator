import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { runTests } from '../../db/schema/runs.js';
import { testAttachments, tests } from '../../db/schema/tests.js';
import { AppError, ConflictError, NotFoundError } from '../../errors.js';
import type { Clock } from '../../lib/clock.js';
import { audit } from '../audit/audit.js';
import type { Actor } from '../auth/actor.js';
import { countPdfPages, detectFileType } from './filetype.js';
import type { PublicAttachment } from './tests.service.js';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TEST = 10;
const HEAD_BYTES = 16;
const MAX_NAME_CHARS = 255;

export type AttachmentsDeps = {
  db: Db;
  clock: Clock;
  config: Pick<AppConfig, 'dataDir'>;
};

const tooLarge = () => new AppError('file_too_large', 413, 'Fichier trop volumineux (10 Mo au plus)');
const unsupported = () =>
  new AppError('unsupported_file_type', 415, 'Type de fichier non pris en charge : PNG, JPEG, WebP ou PDF');
const testArchived = () => new ConflictError('test_archived', 'Test archivé : aucune pièce jointe ne peut y être ajoutée');

/** Chemin absolu de `relative` sous `dataDir` ; refuse tout chemin qui en sort. */
export function resolveAttachmentPath(dataDir: string, relative: string): string {
  const root = path.resolve(dataDir);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw new Error('Chemin de pièce jointe hors du dossier de données');
  return file;
}

/** Nom d'origine affichable : sans dossier, sans caractère de contrôle, 255 caractères au plus. */
function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_NAME_CHARS);
  return cleaned === '' ? 'fichier' : cleaned;
}

export function publicAttachment(a: typeof testAttachments.$inferSelect): PublicAttachment {
  return { id: a.id, originalName: a.originalName, mime: a.mime, size: a.size, pages: a.pages, sha256: a.sha256 };
}

class TooLargeError extends Error {}

/** Écrit le flux dans `dest` en contrôlant la taille et en calculant l'empreinte. */
async function writeLimited(stream: Readable, dest: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > MAX_ATTACHMENT_BYTES) return cb(new TooLargeError());
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(stream, counter, createWriteStream(dest, { mode: 0o600 }));
  // @fastify/multipart tronque le flux qui dépasse sa limite (sans erreur si `throwFileSizeLimit` est faux).
  if ((stream as Readable & { truncated?: boolean }).truncated === true) throw new TooLargeError();
  return { size, sha256: hash.digest('hex') };
}

async function readHead(file: string): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Ajoute une pièce jointe : écriture dans un fichier temporaire du dossier du test, contrôle de la taille et de la
 * signature, puis renommage. Tout refus supprime le fichier temporaire.
 */
export async function addAttachment(
  deps: AttachmentsDeps,
  actor: Actor,
  testId: string,
  file: { filename: string; stream: Readable },
): Promise<PublicAttachment> {
  const [test] = await deps.db.select({ id: tests.id, archivedAt: tests.archivedAt }).from(tests).where(eq(tests.id, testId));
  if (!test) throw new NotFoundError('Test introuvable');
  if (test.archivedAt !== null) throw testArchived();
  const [active] = await deps.db
    .select({ n: count() })
    .from(testAttachments)
    .where(and(eq(testAttachments.testId, testId), isNull(testAttachments.deletedAt)));
  if (Number(active!.n) >= MAX_ATTACHMENTS_PER_TEST) {
    throw new ConflictError('too_many_attachments', 'Dix pièces jointes au plus par test');
  }

  const id = randomUUID();
  const relative = path.posix.join('attachments', testId, id);
  const dest = resolveAttachmentPath(deps.config.dataDir, relative);
  const tmp = `${dest}.part`;
  await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  try {
    let written: { size: number; sha256: string };
    try {
      written = await writeLimited(file.stream, tmp);
    } catch (err) {
      if (err instanceof TooLargeError || (err as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
      throw err;
    }
    const mime = detectFileType(await readHead(tmp));
    if (mime === null) throw unsupported();
    const pages = mime === 'application/pdf' ? countPdfPages(await readFile(tmp)) : null;
    try {
      // Contrôle faisant foi du plafond : sous verrou de la ligne du test, pour que des dépôts parallèles se sérialisent.
      await deps.db.transaction(async (tx) => {
        const [locked] = await tx.select({ archivedAt: tests.archivedAt }).from(tests).where(eq(tests.id, testId)).for('update');
        if (!locked) throw new NotFoundError('Test introuvable');
        if (locked.archivedAt !== null) throw testArchived(); // archivé pendant l'écriture du fichier
        const [now] = await tx
          .select({ n: count() })
          .from(testAttachments)
          .where(and(eq(testAttachments.testId, testId), isNull(testAttachments.deletedAt)));
        if (Number(now!.n) >= MAX_ATTACHMENTS_PER_TEST) {
          throw new ConflictError('too_many_attachments', 'Dix pièces jointes au plus par test');
        }
        await rename(tmp, dest);
        await tx.insert(testAttachments).values({
          id,
          testId,
          originalName: cleanName(file.filename),
          mime,
          size: written.size,
          storagePath: relative,
          sha256: written.sha256,
          pages,
        });
        await audit(tx, {
          actorUserId: actor.userId,
          action: 'test_attachment_added',
          targetType: 'test',
          targetId: testId,
          details: { attachmentId: id, mime, size: written.size },
        });
      });
    } catch (err) {
      await rm(dest, { force: true }).catch(() => undefined); // rien ne reste si l'insertion ou la validation échoue
      throw err;
    }
    const [row] = await deps.db.select().from(testAttachments).where(eq(testAttachments.id, id));
    return publicAttachment(row!);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Ligne active de la pièce jointe, ou 404. */
export async function findAttachment(deps: AttachmentsDeps, testId: string, attachmentId: string) {
  const [row] = await deps.db
    .select()
    .from(testAttachments)
    .where(and(eq(testAttachments.id, attachmentId), eq(testAttachments.testId, testId), isNull(testAttachments.deletedAt)));
  if (!row) throw new NotFoundError('Pièce jointe introuvable');
  return row;
}

/** Retire une pièce jointe : gardée (marquée retirée) si un instantané de série la référence, sinon effacée. */
export async function removeAttachment(
  deps: AttachmentsDeps,
  actor: Actor,
  testId: string,
  attachmentId: string,
): Promise<'deleted' | 'detached'> {
  // Verrou de la ligne du test : la création d'une série (qui prend le même verrou pour figer l'instantané) ne peut pas
  // s'intercaler entre la vérification des références et le retrait.
  const { outcome, storagePath } = await deps.db.transaction(async (tx) => {
    await tx.select({ id: tests.id }).from(tests).where(eq(tests.id, testId)).for('update');
    const [row] = await tx
      .select()
      .from(testAttachments)
      .where(and(eq(testAttachments.id, attachmentId), eq(testAttachments.testId, testId), isNull(testAttachments.deletedAt)));
    if (!row) throw new NotFoundError('Pièce jointe introuvable');
    const [refs] = await tx
      .select({ n: count() })
      .from(runTests)
      .where(
        and(
          eq(runTests.testId, testId),
          sql`JSON_SEARCH(${runTests.snapshot}, 'one', ${attachmentId}, NULL, '$.attachments[*].id') IS NOT NULL`,
        ),
      );
    const referenced = Number(refs!.n) > 0;
    if (referenced) {
      await tx.update(testAttachments).set({ deletedAt: deps.clock() }).where(eq(testAttachments.id, attachmentId));
    } else {
      await tx.delete(testAttachments).where(eq(testAttachments.id, attachmentId));
    }
    await audit(tx, {
      actorUserId: actor.userId,
      action: 'test_attachment_removed',
      targetType: 'test',
      targetId: testId,
      details: { attachmentId, kept: referenced },
    });
    return { outcome: referenced ? ('detached' as const) : ('deleted' as const), storagePath: row.storagePath };
  });
  if (outcome === 'deleted') {
    // Après validation de la transaction : un échec laisse un fichier orphelin, jamais une ligne sans fichier.
    await rm(resolveAttachmentPath(deps.config.dataDir, storagePath), { force: true }).catch((err: unknown) => {
      console.warn(`Pièce jointe : fichier non effacé (${err instanceof Error ? err.name : 'erreur'})`);
    });
  }
  return outcome;
}

/** Contenu du fichier d'une pièce jointe ; le chemin est résolu sous `DATA_DIR` uniquement. */
export async function readAttachment(deps: { dataDir: string }, a: { storagePath: string }): Promise<Buffer> {
  return readFile(resolveAttachmentPath(deps.dataDir, a.storagePath));
}
