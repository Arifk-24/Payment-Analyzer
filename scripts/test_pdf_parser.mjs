import fs from 'fs';
import path from 'path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

function extractTextFromPdf(filePath, maxPages = 5) {
  return new Promise(async (resolve, reject) => {
    try {
      const data = new Uint8Array(fs.readFileSync(filePath));
      const loadingTask = pdfjsLib.getDocument({ data });
      const pdf = await loadingTask.promise;
      const pageCount = Math.min(pdf.numPages, maxPages);
      let fullText = '';
      for (let i = 1; i <= pageCount; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        // build text
        const lines = [];
        let currentY = null;
        let line = '';
        for (const item of content.items) {
          const y = Math.round(item.transform[5]);
          if (currentY === null) currentY = y;
          if (Math.abs(y - currentY) > 5) {
            if (line.trim()) lines.push(line.trim());
            line = '';
            currentY = y;
          }
          line += item.str + ' ';
        }
        if (line.trim()) lines.push(line.trim());
        const pageText = lines.join('\n');
        fullText += pageText + '\n---PAGE BREAK---\n';
      }
      resolve(fullText);
    } catch (err) {
      reject(err);
    }
  });
}

// PhonePe parser (aligned with app parser)
function normalizePhonePeText(text) {
  return text
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePhonePeDate(dateText) {
  const match = dateText.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s*(\d{4})/i);
  if (match) {
    const monthMap = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
    const month = monthMap[match[0].split(' ')[0].slice(0, 3).toLowerCase()] ?? 1;
    return `${match[2]}-${String(month).padStart(2, '0')}-${String(parseInt(match[1], 10)).padStart(2, '0')}`;
  }

  const slashMatch = dateText.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slashMatch) {
    return `${slashMatch[3]}-${String(parseInt(slashMatch[2], 10)).padStart(2, '0')}-${String(parseInt(slashMatch[1], 10)).padStart(2, '0')}`;
  }

  return null;
}

function parsePhonePeTime(dateText) {
  const match = dateText.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const meridiem = (match[4] || '').toLowerCase();

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  return `${String(hours).padStart(2, '0')}:${minutes}:00`;
}

function parsePhonePeAmount(text) {
  const match = text.match(/(?:₹|Rs\.?|INR)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i);
  if (!match) return null;
  return parseFloat(match[1].replace(/,/g, ''));
}

function extractPhonePePayee(text) {
  const partyMatch = text.match(/(?:Paid to|Received from|Transfer to|Transferred to|Paid via|Mobile recharged)\s+(.+?)(?:\s+Transaction ID\s+|\s+UTR\s+(?:No\.?\s*)?|\s+Status\s+|$)/i);
  if (!partyMatch) return 'Unknown';
  return partyMatch[1].replace(/\s+Transaction ID.*$/i, '').replace(/\s+UTR.*$/i, '').trim() || 'Unknown';
}

function extractPhonePeUtr(text) {
  const match = text.match(/UTR\s*(?:No\.?|Number\.?|#)?\s*[:#]?\s*([A-Za-z0-9]+)/i);
  return match ? match[1].trim() : undefined;
}

function parsePhonePeStatement(text) {
  const normalized = normalizePhonePeText(text);
  const transactionRegex = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[A-Za-z]*\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s*(?:am|pm)?\s*(?:DEBIT|CREDIT|RECEIVED|PAID)\s*(?:₹|Rs\.?|INR)?\s*\d[\d,]*(?:\.\d+)?\s*(?:Paid to|Received from|Transfer to|Transferred to|Paid via|Mobile recharged|Payment to|Payment from)[^\n]{0,250}/gi;
  const matches = [...normalized.matchAll(transactionRegex)];
  const transactions = [];

  for (const match of matches) {
    const chunk = match[0];
    const date = parsePhonePeDate(chunk);
    const time = parsePhonePeTime(chunk);
    const amount = parsePhonePeAmount(chunk);

    if (!date || amount === null) continue;

    transactions.push({
      date,
      time,
      payee: extractPhonePePayee(chunk),
      description: chunk,
      amount,
      utr: extractPhonePeUtr(chunk),
    });
  }

  return transactions;
}

// original script logic below, replacing the weak parser with the improved one
function extractPhonePeTransaction(blockText) {
  const text = blockText;
  const date = parsePhonePeDate(text);
  const time = parsePhonePeTime(text);
  const amount = parsePhonePeAmount(text);

  if (!date || amount === null) return null;

  return {
    date,
    time,
    payee: extractPhonePePayee(text),
    description: text,
    amount,
    utr: extractPhonePeUtr(text),
  };
}

function parseLegacy(text) {
  const transactions = [];
  const lines = text.split('\n').filter((l) => l.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/Paid to/i.test(line) || /Received from/i.test(line) || /DEBIT/i.test(line)) {
      const block = [lines[i - 2], lines[i - 1], lines[i], lines[i + 1], lines[i + 2]].filter(Boolean).join(' ');
      const tx = extractPhonePeTransaction(block);
      if (tx) transactions.push(tx);
    }
  }
  return transactions;
}

(async ()=>{
  try{
    const filePath = process.argv[2] || path.resolve('test.pdf');
    if(!fs.existsSync(filePath)){
      console.error('File not found:', filePath);
      process.exit(2);
    }
    const text = await extractTextFromPdf(filePath, 5);
    // detect format
    const txtLower = text.toLowerCase();
    let source='UNKNOWN';
    if (txtLower.includes('phonepe') || txtLower.includes('utr no') || txtLower.includes('paid to')) source='PHONEPE';
    else if (txtLower.includes('google pay') || txtLower.includes('upi transaction id')) source='GPAY';
    else if (txtLower.includes('statement period') || (txtLower.includes('dr') && txtLower.includes('cr'))) source='CREDIT_CARD';

    console.log('Detected source:', source);

    let raw = [];
    if (source === 'PHONEPE') {
      raw = parsePhonePeStatement(text);
      if (raw.length === 0) raw = parseLegacy(text);
    }

    console.log('\nFound raw transactions:', raw.length);
    console.log(JSON.stringify(raw.slice(0, 20), null, 2));

  }catch(err){
    console.error(err);
    process.exit(1);
  }
})();
