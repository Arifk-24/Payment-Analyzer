import type { TransactionScope } from '../types/finance';
import { spendingCreditSql } from '../utils/spending';

export interface AnalyticsDatabase {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface AnalyticsMutationDatabase extends AnalyticsDatabase {
  exec(sql: string, params?: unknown[]): Promise<{ rowsModified: number }>;
}

export async function updateTransactionCategory(
  db: AnalyticsMutationDatabase,
  id: string,
  newCategory: string
): Promise<number> {
  const result = await db.exec(
    'UPDATE transactions SET category = ? WHERE id = ?',
    [newCategory, id]
  );
  return result.rowsModified;
}

export async function updateTransactionScope(
  db: AnalyticsMutationDatabase,
  id: string,
  newScope: 'self' | 'home'
): Promise<number> {
  const result = await db.exec(
    'UPDATE transactions SET scope = ? WHERE id = ?',
    [newScope, id]
  );
  return result.rowsModified;
}

export interface OutflowTransaction {
  id: string;
  transactionDate: string;
  transactionTime: string | null;
  cleanPartyName: string;
  rawDescription: string;
  amount: number;
  category: string;
}

export interface MerchantSpend {
  merchant: string;
  totalSpent: number;
  transactionCount: number;
}

export interface BurnSplit {
  fixed: number;
  discretionary: number;
}

export interface MonthlyCategorySpend {
  category: string;
  netAmount: number;
}

function validateMonthYear(monthYear: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthYear)) {
    throw new Error('monthYear must use YYYY-MM format');
  }
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('limit must be a positive integer');
  }
}

const MONTH_FILTER = `transaction_date LIKE ?`;
const NON_TRANSFER_EXPENSE_FILTER = `
  flow_type = 'EXPENSE'
  AND LOWER(COALESCE(category, '')) != 'internal transfer'
`;
const MERCHANT_KEY_SQL = `COALESCE(
  (
    SELECT rule.pattern
    FROM merchant_rules AS rule
    WHERE INSTR(
      UPPER(COALESCE(tx.raw_description, '') || ' ' || COALESCE(tx.clean_party_name, '')),
      UPPER(rule.pattern)
    ) > 0
    ORDER BY LENGTH(rule.pattern) DESC
    LIMIT 1
  ),
  NULLIF(TRIM(tx.clean_party_name), ''),
  'Unknown'
)`;

type ScopeFilter = TransactionScope | 'all';

function scopeFilterSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return `(? = 'all' OR ${prefix}scope = ?)`;
}

export async function getMonthlyCategorySpending(
  db: AnalyticsDatabase,
  selectedMonth: string,
  scopeFilter: ScopeFilter = 'all'
): Promise<MonthlyCategorySpend[]> {
  validateMonthYear(selectedMonth);
  return db.query<MonthlyCategorySpend>(
    `
      SELECT
        COALESCE(NULLIF(category, ''), 'Uncategorized') AS category,
        COALESCE(SUM(
          CASE
            WHEN flow_type = 'EXPENSE' THEN amount
            WHEN ${spendingCreditSql()} THEN -amount
            ELSE 0
          END
        ), 0) AS netAmount
      FROM transactions
      WHERE transaction_date LIKE ?
        AND COALESCE(NULLIF(category, ''), 'Uncategorized')
          NOT IN ('Personal Transfer', 'Internal Transfer', 'Salary & Income')
        AND flow_type IN ('EXPENSE', 'INCOME')
        AND (? = 'all' OR scope = ?)
      GROUP BY COALESCE(NULLIF(category, ''), 'Uncategorized')
      HAVING netAmount > 0
      ORDER BY netAmount DESC
    `,
    [`${selectedMonth}%`, scopeFilter, scopeFilter]
  );
}

export async function getTopOutflows(
  db: AnalyticsDatabase,
  monthYear: string,
  limit = 5,
  scope: ScopeFilter = 'all'
): Promise<OutflowTransaction[]> {
  validateMonthYear(monthYear);
  validateLimit(limit);

  return db.query<OutflowTransaction>(
    `
      SELECT
        id,
        transaction_date AS transactionDate,
        transaction_time AS transactionTime,
        clean_party_name AS cleanPartyName,
        raw_description AS rawDescription,
        amount,
        category
      FROM transactions
      WHERE ${MONTH_FILTER}
        AND ${NON_TRANSFER_EXPENSE_FILTER}
        AND COALESCE(category, 'Uncategorized') NOT IN ('Personal Transfer', 'Salary & Income')
        AND ${scopeFilterSql()}
        AND LOWER(COALESCE(category, '')) != 'rent'
        AND INSTR(
          ' ' || LOWER(COALESCE(category, '') || ' ' || COALESCE(clean_party_name, '') || ' ' || COALESCE(raw_description, '')) || ' ',
          ' rent '
        ) = 0
      ORDER BY amount DESC, transaction_date DESC, id
      LIMIT ?
    `,
    [`${monthYear}%`, scope, scope, limit]
  );
}

export async function getSpendByMerchant(
  db: AnalyticsDatabase,
  monthYear: string,
  limit = 5,
  scope: ScopeFilter = 'all'
): Promise<MerchantSpend[]> {
  validateMonthYear(monthYear);
  validateLimit(limit);

  return db.query<MerchantSpend>(
    `
      WITH monthly_transactions AS (
        SELECT tx.*, ${MERCHANT_KEY_SQL} AS merchant
        FROM transactions AS tx
        WHERE tx.transaction_date LIKE ?
          AND ${scopeFilterSql('tx')}
      ),
      expenses AS (
        SELECT merchant, SUM(amount) AS totalSpent, COUNT(*) AS transactionCount
        FROM monthly_transactions
        WHERE ${NON_TRANSFER_EXPENSE_FILTER}
          AND COALESCE(category, 'Uncategorized') NOT IN ('Personal Transfer', 'Salary & Income')
        GROUP BY merchant
      )
      SELECT
        expenses.merchant,
        expenses.totalSpent,
        expenses.transactionCount
      FROM expenses
      ORDER BY expenses.totalSpent DESC, expenses.merchant COLLATE NOCASE
      LIMIT ?
    `,
    [`${monthYear}%`, scope, scope, limit]
  );
}

export async function getBurnSplit(
  db: AnalyticsDatabase,
  monthYear: string,
  scope: ScopeFilter = 'all'
): Promise<BurnSplit> {
  validateMonthYear(monthYear);

  const rows = await db.query<BurnSplit>(
    `
      WITH monthly_transactions AS (
        SELECT *
        FROM transactions
        WHERE transaction_date LIKE ?
          AND ${scopeFilterSql()}
      ),
      expenses AS (
        SELECT *
        FROM monthly_transactions
        WHERE flow_type IN ('EXPENSE', 'INCOME')
          AND COALESCE(NULLIF(category, ''), 'Uncategorized')
            NOT IN ('Personal Transfer', 'Internal Transfer', 'Salary & Income')
      )
      SELECT
        COALESCE(SUM(
          CASE
            WHEN LOWER(COALESCE(expense.category, '')) LIKE '%rent%'
              OR LOWER(COALESCE(expense.category, '')) LIKE '%utilit%'
              OR LOWER(COALESCE(expense.category, '')) LIKE '%wifi%'
              OR LOWER(COALESCE(expense.category, '')) LIKE '%wi-fi%'
              OR LOWER(COALESCE(expense.category, '')) LIKE '%broadband%'
              OR LOWER(COALESCE(expense.category, '')) LIKE '%fiber%' THEN
              CASE
                WHEN expense.flow_type = 'EXPENSE' THEN expense.amount
                WHEN ${spendingCreditSql('expense')} THEN -expense.amount
                ELSE 0
              END
            ELSE 0
          END
        ), 0) AS fixed,
        COALESCE(SUM(
          CASE
            WHEN LOWER(COALESCE(expense.category, '')) NOT LIKE '%rent%'
              AND LOWER(COALESCE(expense.category, '')) NOT LIKE '%utilit%'
              AND LOWER(COALESCE(expense.category, '')) NOT LIKE '%wifi%'
              AND LOWER(COALESCE(expense.category, '')) NOT LIKE '%wi-fi%'
              AND LOWER(COALESCE(expense.category, '')) NOT LIKE '%broadband%'
              AND LOWER(COALESCE(expense.category, '')) NOT LIKE '%fiber%' THEN
              CASE
                WHEN expense.flow_type = 'EXPENSE' THEN expense.amount
                WHEN ${spendingCreditSql('expense')} THEN -expense.amount
                ELSE 0
              END
            ELSE 0
          END
        ), 0) AS discretionary
      FROM expenses AS expense
    `,
    [`${monthYear}%`, scope, scope]
  );

  return rows[0] || { fixed: 0, discretionary: 0 };
}
