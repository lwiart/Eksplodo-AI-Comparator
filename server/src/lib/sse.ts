/** Un événement SSE : nom optionnel et données (lignes `data:` jointes par `\n`). */
export type SseEvent = { event: string | null; data: string };

/**
 * Lit un flux « text/event-stream » et produit un événement par bloc terminé par une ligne vide.
 * Les commentaires (`:`) et les champs `id` / `retry` sont ignorés. Si `signal` est annulé,
 * le flux est annulé et `signal.reason` est relancée.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  let buffer = '';
  let event: string | null = null;
  let dataLines: string[] = [];

  // Traite une ligne complète ; retourne un événement quand un bloc se termine.
  const handleLine = (line: string): SseEvent | null => {
    if (line === '') {
      const out = dataLines.length > 0 ? { event, data: dataLines.join('\n') } : null;
      event = null;
      dataLines = [];
      return out;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    return null;
  };

  // Extrait les lignes complètes du tampon ; un `\r` final attend le paquet suivant (CRLF possible).
  const takeLines = (final: boolean): string[] => {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      if (c === '\n') {
        lines.push(buffer.slice(start, i));
        start = i + 1;
      } else if (c === '\r') {
        if (i === buffer.length - 1 && !final) break;
        lines.push(buffer.slice(start, i));
        if (buffer[i + 1] === '\n') i++;
        start = i + 1;
      }
    }
    buffer = buffer.slice(start);
    return lines;
  };

  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of takeLines(false)) {
        const e = handleLine(line);
        if (e) yield e;
      }
    }
    buffer += decoder.decode();
    for (const line of takeLines(true)) {
      const e = handleLine(line);
      if (e) yield e;
    }
    if (buffer !== '') {
      const e = handleLine(buffer);
      if (e) yield e;
    }
    // Bloc final non terminé par une ligne vide.
    const last = handleLine('');
    if (last) yield last;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => undefined);
  }
}
