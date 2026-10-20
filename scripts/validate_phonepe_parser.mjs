import fs from 'fs';
import path from 'path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parsePhonePeStatement } from '../src/engine/parsers/phonepeParser.ts';

const file = process.argv[2] || path.resolve('test.pdf');
const data = new Uint8Array(fs.readFileSync(file));
const pdf = await pdfjsLib.getDocument({ data }).promise;
let fullText = '';

for (let i = 1; i <= Math.min(pdf.numPages, 5); i++) {
  const page = await pdf.getPage(i);
  const textContent = await page.getTextContent();
  let currentY = 0;
  let line = '';
  const lines = [];

  for (const item of textContent.items) {
    const y = item.transform?.[5] ?? 0;
    if (Math.abs(y - currentY) > 5 && line.trim()) {
      lines.push(line.trim());
      line = '';
    }
    currentY = y;
    line += (item.str || '') + ' ';
  }

  if (line.trim()) lines.push(line.trim());
  fullText += lines.join('\n') + '\n---PAGE BREAK---\n';
}

const txs = parsePhonePeStatement(fullText);
console.log('count', txs.length);
console.log(JSON.stringify(txs.slice(0, 3), null, 2));
