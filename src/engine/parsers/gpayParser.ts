import type { RawTransaction } from './phonepeParser';
import { extractStatementBlocks, normalizeStatementText } from './statementNormalizer';

/**
 * Parses Google Pay statement text and extracts transactions
 */
export function parseGPayStatement(text: string): RawTransaction[] {
  const normalized = normalizeStatementText(text);
  const blocks = extractStatementBlocks(normalized);
  const transactions: RawTransaction[] = [];

  for (const block of blocks) {
    const chunk = block.replace(/\s+/g, ' ').trim();
    if (!/(UPI\/|Google Pay|upi\/|Transaction|Paid to|Received from|Debited|Credited)/i.test(chunk)) {
      continue;
    }

    const txData = extractGPayStatementBlock(chunk);
    if (txData) {
      transactions.push(txData);
    }
  }

  return transactions;
}

function extractGPayStatementBlock(block: string): RawTransaction | null {
  const upiMatch = block.match(/UPI\/([^\/]*?)\/([^\/]*?)\/(\d{8})\/([^\/]*?)\/([^\/]*?)\/([^\/]*?)(?:\s|$)/i);
  if (upiMatch) {
    const dateStr = upiMatch[3];
    const date = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    const amountStr = upiMatch[4].replace(/,/g, '');
    const amount = parseFloat(amountStr) || 0;
    const utc = upiMatch[5].trim();
    const vpa = upiMatch[6].trim();

    return {
      date,
      time: null,
      payee: vpa || 'Unknown',
      description: block,
      amount,
      utc,
    };
  }

  const date = parseGPayDate(block);
  if (!date) return null;

  const time = parseGPayTime(block);

  const amountMatch = block.match(/(?:₹|Rs\.?|INR)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/i);
  if (!amountMatch) return null;

  const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  const payeeMatch = block.match(/(?:Paid to|Received from)\s+(.+?)(?=\s+(?:₹|Rs\.?|INR)\s*[\d,]|\s+UPI Transaction ID\b|\s+Paid (?:by|to)\b|$)/i);
  const payee = payeeMatch?.[1].trim() || 'Unknown';
  const utc = block.match(/UPI Transaction ID\s*:\s*([A-Za-z0-9]+)/i)?.[1]?.trim()
    || block.match(/UTR\s*(?:No\.?|Number\.?|#)?\s*[:#]?\s*([A-Za-z0-9]+)/i)?.[1]?.trim();

  return {
    date,
    time,
    payee,
    description: block,
    amount,
    utc,
  };
}

function parseGPayDate(block: string): string | null {
  const monthByName: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
  };
  const textDate = block.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[A-Za-z]*,?\s+(\d{4})\b/i);
  if (textDate) {
    const month = monthByName[textDate[2].toLowerCase()];
    return `${textDate[3]}-${month}-${textDate[1].padStart(2, '0')}`;
  }

  const numericDate = block.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  if (numericDate) {
    return `${numericDate[3]}-${numericDate[2].padStart(2, '0')}-${numericDate[1].padStart(2, '0')}`;
  }

  return null;
}

function parseGPayTime(block: string): string | null {
  const match = block.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) return null;

  let hours = Number(match[1]);
  const meridiem = match[4].toLowerCase();
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  return `${String(hours).padStart(2, '0')}:${match[2]}:${(match[3] || '00').padStart(2, '0')}`;
}
