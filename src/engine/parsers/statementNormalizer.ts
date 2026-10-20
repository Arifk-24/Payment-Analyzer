const MONTH_PATTERN = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|ept|Oct|Nov|Dec)';

export function normalizeStatementText(text: string): string {
  return text
    .replace(/\b(?:ept)\b/gi, 'Sept')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractStatementBlocks(text: string): string[] {
  const normalized = normalizeStatementText(text);
  const datePattern = `(?:${MONTH_PATTERN}[A-Za-z]*\\s+\\d{1,2},\\s*\\d{4}|\\d{1,2}\\s+${MONTH_PATTERN}[A-Za-z]*,?\\s+\\d{4}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{4})`;
  const dateMatches = Array.from(normalized.matchAll(new RegExp(datePattern, 'gi')));
  const transactionStarts = dateMatches.filter((match, index) => {
    const start = match.index ?? 0;
    const end = dateMatches[index + 1]?.index ?? normalized.length;
    const candidate = normalized.slice(start, end);
    return /(?:Paid to|Received from|Transfer to|Transferred to|Mobile recharged|DEBIT|CREDIT)[\s\S]{0,160}(?:₹|Rs\.?|INR)/i.test(candidate);
  });

  if (transactionStarts.length > 0) {
    return transactionStarts.map((match, index) => {
      const start = match.index ?? 0;
      const end = transactionStarts[index + 1]?.index ?? normalized.length;
      return normalized.slice(start, end).replace(/\s+/g, ' ').trim();
    });
  }

  return normalized
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && /\d/.test(line));
}
