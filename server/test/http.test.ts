import { expect, test } from 'vitest';
import { contentDisposition, wantsInline } from '../src/lib/http.js';

test('contentDisposition : attachment par défaut, inline sur demande, même nom encodé', () => {
  expect(contentDisposition('été.pdf')).toBe(`attachment; filename="_t_.pdf"; filename*=UTF-8''%C3%A9t%C3%A9.pdf`);
  expect(contentDisposition('été.pdf', true)).toBe(`inline; filename="_t_.pdf"; filename*=UTF-8''%C3%A9t%C3%A9.pdf`);
});

test('wantsInline : seulement ?inline=1 et un type affichable (image ou PDF)', () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']) expect(wantsInline({ inline: '1' }, mime)).toBe(true);
  expect(wantsInline({ inline: '1' }, 'text/html')).toBe(false);
  expect(wantsInline({ inline: '1' }, 'image/svg+xml')).toBe(false);
  expect(wantsInline({ inline: 'true' }, 'image/png')).toBe(false);
  expect(wantsInline({ inline: ['1', '1'] }, 'image/png')).toBe(false);
  expect(wantsInline({}, 'image/png')).toBe(false);
  expect(wantsInline(undefined, 'image/png')).toBe(false);
});
