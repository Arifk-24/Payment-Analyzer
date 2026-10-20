import { extractStatementBlocks, normalizeStatementText } from './statementNormalizer';

/**
 * Raw transaction before classification
 */
export interface RawTransaction {
  date: string;
  time: string | null;
  payee: string;
  description: string;
  amount: number;
  utc?: string;
}

const MONTHS = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
  ['jul', 7], ['aug', 8], ['sep', 9], ['sept', 9], ['ept', 9], ['oct', 10], ['nov', 11], ['dec', 12],
]);

function normalizeMonthToken(token: string): number | null {
  const cleaned = token.replace(/[^A-Za-z]/g, '').toLowerCase();
  const normalized = cleaned === 'ept' ? 'sept' : cleaned;
  return MONTHS.get(normalized) ?? null;
}

function parsePhonePeDate(dateText: string): string | null {
  const match = dateText.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|ept|Oct|Nov|Dec))[A-Za-z]*\s+(\d{1,2}),\s*(\d{4})/i);
  if (match) {
    const month = normalizeMonthToken(match[1]);
    if (!month) return null;
    return `${match[3]}-${String(month).padStart(2, '0')}-${String(parseInt(match[2], 10)).padStart(2, '0')}`;
  }

  const slashMatch = dateText.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slashMatch) {
    return `${slashMatch[3]}-${String(parseInt(slashMatch[2], 10)).padStart(2, '0')}-${String(parseInt(slashMatch[1], 10)).padStart(2, '0')}`;
  }

  return null;
}

function parsePhonePeTime(dateText: string): string | null {
  const match = dateText.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const meridiem = (match[4] || '').toLowerCase();

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  return `${String(hours).padStart(2, '0')}:${minutes}:00`;
}

function parsePhonePeAmount(text: string): number | null {
  const match = text.match(/(?:₹|Rs\.?|INR)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i);
  if (!match) return null;
  return parseFloat(match[1].replace(/,/g, ''));
}

function extractPhonePePayee(text: string): string {
  const partyMatch = text.match(/(?:Paid to|Received from|Transfer to|Transferred to|Paid via|Mobile recharged|Payment to|Electricity bill paid)\s+(.+?)(?:\s+Transaction ID\s+|\s+UTR\s+(?:No\.?\s*)?|\s+Status\s+|$)/i);
  if (!partyMatch) return 'Unknown';

  return partyMatch[1].replace(/\s+Transaction ID.*$/i, '').replace(/\s+UTR.*$/i, '').trim() || 'Unknown';
}

function extractPhonePeUtr(text: string): string | undefined {
  const match = text.match(/UTR\s*(?:No\.?|Number\.?|#)?\s*[:#]?\s*([A-Za-z0-9]+)/i);
  return match ? match[1].trim() : undefined;
}

/**
 * Parses PhonePe statement text and extracts transactions
 */
export function parsePhonePeStatement(text: string): RawTransaction[] {
  const normalized = normalizeStatementText(text);
  const blocks = extractStatementBlocks(normalized);
  const transactions: RawTransaction[] = [];

  for (const block of blocks) {
    const chunk = block.replace(/\s+/g, ' ').trim();
    if (!/(Paid to|Received from|Transfer to|Transferred to|Mobile recharged|DEBIT|CREDIT)/i.test(chunk)) {
      continue;
    }

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
      utc: extractPhonePeUtr(chunk),
    });
  }

  return transactions;
}
