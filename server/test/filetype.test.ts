import { expect, test } from 'vitest';
import { countPdfPages, detectFileType } from '../src/modules/tests/filetype.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);
const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
const pdf3 = Buffer.from(
  '%PDF-1.4\n<< /Type /Pages /Count 3 >>\n<< /Type /Page >>\n<< /Type/Page /Parent 2 0 R >>\n<< /Type /Page >>\n',
);

test.each([
  [png, 'image/png'],
  [jpeg, 'image/jpeg'],
  [webp, 'image/webp'],
  [pdf, 'application/pdf'],
  [Buffer.from('<html>'), null],
  [Buffer.from('<svg'), null],
  [Buffer.from('RIFF....WAVEfmt '), null],
  [Buffer.alloc(0), null],
])('signature %#', (b, t) => {
  expect(detectFileType(b)).toBe(t);
});

test('PDF de 3 pages (le nœud /Pages n’est pas compté)', () => {
  expect(countPdfPages(pdf3)).toBe(3);
});

test('PDF sans page repérable : au moins 1', () => {
  expect(countPdfPages(pdf)).toBe(1);
});
