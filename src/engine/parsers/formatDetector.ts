import { StatementSource } from '../../types/finance';

/**
 * Detects the source of a bank/payment statement based on text content
 */
export function detectStatementFormat(
  extractedText: string
): StatementSource | 'UNKNOWN' {
  const text = extractedText.toLowerCase();

  // Google Pay detection
  if (
    text.includes('google pay') ||
    text.includes('upi transaction id') ||
    text.includes('google india digital services') ||
    text.includes('your transactions')
  ) {
    return 'GPAY';
  }

  // PhonePe detection
  if (
    text.includes('phonepe') ||
    text.includes('transaction statement for') ||
    text.includes('utr no') ||
    text.includes('phonepe wallet') ||
    /upi\/[^\s]+/i.test(text)
  ) {
    return 'PHONEPE';
  }

  // Credit Card detection
  if (
    text.includes('statement period') ||
    text.includes('credit limit') ||
    text.includes('total amount due') ||
    text.includes('domestic transactions') ||
    (text.includes('dr') && text.includes('cr')) ||
    text.includes('opening balance') ||
    text.includes('closing balance')
  ) {
    return 'CREDIT_CARD';
  }

  return 'UNKNOWN';
}
