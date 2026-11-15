import type { ParsedTransaction } from '../types/finance';

export function isSpendingCategory(category: string | null | undefined): boolean {
  return Boolean(
    category &&
      category !== 'Personal Transfer' &&
      category !== 'Internal Transfer' &&
    category !== 'Investments & Savings' &&
      category !== 'Salary & Income'
  );
}

export function isSpendingCredit(
  transaction: Pick<
    ParsedTransaction,
    'flowType' | 'category'
  >
): boolean {
  return transaction.flowType === 'INCOME' &&
    isSpendingCategory(transaction.category) &&
    transaction.category !== 'Uncategorized';
}

export function isSpendingOffset(
  transaction: Pick<
    ParsedTransaction,
    'flowType' | 'category'
  >
): boolean {
  return isSpendingCredit(transaction);
}

export function getSpendingImpact(
  transaction: Pick<
    ParsedTransaction,
    'flowType' | 'category' | 'amount'
  >
): number {
  if (!isSpendingCategory(transaction.category)) return 0;
  if (transaction.flowType === 'EXPENSE') return transaction.amount;
  if (isSpendingCredit(transaction)) return -transaction.amount;
  return 0;
}

export function spendingCreditSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return `(
    ${prefix}flow_type = 'INCOME'
    AND ${prefix}category NOT IN ('Personal Transfer', 'Internal Transfer', 'Investments & Savings', 'Salary & Income', 'Uncategorized')
  )`;
}
