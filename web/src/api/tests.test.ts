import { afterEach, expect, test, vi } from 'vitest';
import { uploadAttachment } from './tests';

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  csrfToken: () => Promise.resolve('jeton'),
}));

class FakeXhr {
  static last: FakeXhr;
  upload = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  responseText = '';
  constructor() {
    FakeXhr.last = this;
  }
  open() {}
  setRequestHeader() {}
  send() {}
}
afterEach(() => vi.unstubAllGlobals());

async function start() {
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  const promise = uploadAttachment('t1', new File(['x'], 'a.png'));
  const caught = promise.catch((e: unknown) => e);
  await vi.waitFor(() => expect(FakeXhr.last.onload).not.toBeNull());
  return { xhr: FakeXhr.last, result: caught };
}

test('2xx avec un corps illisible → rejet ApiError, jamais en attente', async () => {
  const { xhr, result } = await start();
  xhr.status = 201;
  xhr.responseText = '<html>';
  xhr.onload?.();
  expect(await result).toMatchObject({ name: 'ApiError', status: 201 });
});

test('413 du proxy (corps non JSON) → file_too_large', async () => {
  const { xhr, result } = await start();
  xhr.status = 413;
  xhr.responseText = '<html>Request Entity Too Large</html>';
  xhr.onload?.();
  expect(await result).toMatchObject({ code: 'file_too_large', status: 413 });
});

test('coupure réseau et annulation → rejet « network »', async () => {
  const a = await start();
  a.xhr.onerror?.();
  expect(await a.result).toMatchObject({ code: 'network' });
  const b = await start();
  b.xhr.onabort?.();
  expect(await b.result).toMatchObject({ code: 'network' });
});
