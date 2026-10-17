/** Types affichables dans le navigateur (images et PDF) : seuls eux peuvent être servis en `inline`. */
const INLINE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);

/**
 * `Content-Disposition` : repli ASCII + `filename*` (RFC 5987) pour le nom d'origine.
 * `inline` sert le fichier pour affichage (visionneuse), sinon en pièce jointe (téléchargement).
 */
export function contentDisposition(name: string, inline = false): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** `?inline=1` demandé et type affichable : tout autre type reste en pièce jointe, quoi que demande l'URL. */
export function wantsInline(query: unknown, mime: string): boolean {
  return (query as { inline?: unknown } | null)?.inline === '1' && INLINE_MIMES.has(mime);
}
