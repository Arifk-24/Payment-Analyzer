import type { RawTransaction } from './phonepeParser';
import { extractStatementBlocks, normalizeStatementText } from './statementNormalizer';

/**
 * Parses credit card statement text and extracts transactions
 */
export function parseCreditCardStatement(text: string): RawTransaction[] {
  const normalized = normalizeStatementText(text);
  const blocks = extractStatementBlocks(normalized);
  const transactions: RawTransaction[] = [];

  for (const block of blocks) {
    const chunk = block.replace(/\s+/g, ' ').trim();
    if (!/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec))/.test(chunk)) {
      continue;
    }

    const txData = extractCreditCardTransaction(chunk);
    if (txData) {
      transactions.push(txData);
    }
  }

  return transactions;
}

function extractCreditCardTransaction(block: string): RawTransaction | null {
  const dateMatch = block.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (!dateMatch) return null;

  const date = `${dateMatch[3]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`;
  const amountMatch = block.match(/(?:₹|Rs\.?|INR|\$)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/i);
  if (!amountMatch) return null;

  const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  const merchantMatch = block.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\s+(.*?)(?:\s+(?:₹|Rs\.?|INR|\$)?\s*\d[\d,]*(?:\.\d+)?)/i);
  const merchant = merchantMatch ? merchantMatch[1].trim().replace(/\s+/g, ' ') || 'Unknown' : 'Unknown';

  return {
    date,
    time: null,
    payee: merchant,
    description: block,
    amount,
    utc: undefined,
  };
}
