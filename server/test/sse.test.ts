import { expect, test } from 'vitest';
import { readSse, type SseEvent } from '../src/lib/sse.js';

const enc = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of readSse(stream)) out.push(e);
  return out;
}

const collect = (...chunks: string[]) => drain(streamOf(chunks.map((x) => enc.encode(x))));
const collectBytes = (...chunks: Uint8Array[]) => drain(streamOf(chunks));

test('événements simples et nommés', async () => {
  expect(await collect('data: {"a":1}\n\nevent: message_start\ndata: {"b":2}\n\n')).toEqual([
    { event: null, data: '{"a":1}' },
    { event: 'message_start', data: '{"b":2}' },
  ]);
});

test('ligne coupée entre deux paquets', async () => {
  expect(await collect('da', 'ta: {"x"', ':1}\n', '\n')).toEqual([{ event: null, data: '{"x":1}' }]);
});

test('caractère UTF-8 coupé entre deux paquets', async () => {
  const bytes = enc.encode('data: {"t":"é🚀"}\n\n');
  expect((await collectBytes(bytes.slice(0, 13), bytes.slice(13)))[0]!.data).toBe('{"t":"é🚀"}');
});

test('fins de ligne CRLF', async () => {
  expect(await collect('data: a\r\n\r\ndata: b\r\n\r\n')).toHaveLength(2);
});

test('CRLF coupé entre deux paquets et CR seul', async () => {
  expect(await collect('data: a\r', '\n\r', '\ndata: b\r\r')).toEqual([
    { event: null, data: 'a' },
    { event: null, data: 'b' },
  ]);
});

test('commentaires ignorés', async () => {
  expect(await collect(': OPENROUTER PROCESSING\n\ndata: x\n\n')).toEqual([{ event: null, data: 'x' }]);
});

test('champs id et retry ignorés, un seul espace retiré après les deux-points', async () => {
  expect(await collect('id: 7\nretry: 100\ndata:  deux\n\ndata:sans\n\n')).toEqual([
    { event: null, data: ' deux' },
    { event: null, data: 'sans' },
  ]);
});

test('données sur plusieurs lignes', async () => {
  expect((await collect('data: a\ndata: b\n\n'))[0]!.data).toBe('a\nb');
});

test('dernier bloc sans ligne vide finale', async () => {
  expect(await collect('data: fin')).toEqual([{ event: null, data: 'fin' }]);
});

test('bloc sans données non émis', async () => {
  expect(await collect('event: ping\n\n: seul\n\n')).toEqual([]);
});

test('annulation : lève la raison du signal', async () => {
  const ctrl = new AbortController();
  const silent = new ReadableStream<Uint8Array>({ start() {} });
  const p = (async () => {
    for await (const _ of readSse(silent, ctrl.signal)) void _;
  })();
  ctrl.abort(new Error('stop'));
  await expect(p).rejects.toThrow('stop');
});

test('signal déjà annulé : lève la raison sans lire', async () => {
  const ctrl = new AbortController();
  ctrl.abort(new Error('déjà'));
  const p = (async () => {
    for await (const _ of readSse(streamOf([enc.encode('data: x\n\n')]), ctrl.signal)) void _;
  })();
  await expect(p).rejects.toThrow('déjà');
});
