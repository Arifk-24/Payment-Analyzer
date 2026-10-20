import { ParsedTransaction, MerchantRule, StandardCategory, FlowType } from '../types/finance';
import type { TransactionScope } from '../types/finance';

interface WorkerMessage {
  id: string;
  type: 'QUERY' | 'EXEC' | 'AUTO_CATEGORIZE_BATCH' | 'INSERT_TRANSACTIONS' | 'APPLY_BATCH_REVIEWS' | 'DEDUPLICATE_TRANSACTIONS' | 'CLEAR_ALL_DATA' | 'RESET_CORRUPT_DATABASE';
  sql: string;
  params?: any[];
  transactions?: ParsedTransaction[];
  transactionIds?: string[];
  reviews?: ReviewDecision[];
  expectedDuplicateRows?: number;
}

export interface ReviewDecision {
  id?: string;
  partyName: string;
  category: StandardCategory;
  scope?: TransactionScope;
  applyGlobally?: boolean;
}

export interface DuplicateGroupReport {
  kind: 'UTR event' | 'Fingerprint';
  groupKey: string;
  transactionCount: number;
  removableRows: number;
  categoryVariantCount: number;
  scopeVariantCount: number;
  payeeVariantCount: number;
  amountVariantCount: number;
  dateVariantCount: number;
  sourceVariantCount: number;
  descriptionVariantCount: number;
  dates: string;
  amounts: string;
  descriptionSamples: string;
  categories: string;
  scopes: string;
  payees: string;
}

export interface DuplicateReportSummary {
  kind: 'UTR event' | 'Fingerprint';
  duplicateGroups: number;
  rowsInGroups: number;
  removableRows: number;
  categoryConflictGroups: number;
  scopeConflictGroups: number;
  payeeConflictGroups: number;
  amountConflictGroups: number;
  dateConflictGroups: number;
  sourceConflictGroups: number;
  descriptionConflictGroups: number;
}

export interface DuplicateReport {
  summary: DuplicateReportSummary[];
  groups: DuplicateGroupReport[];
}

interface WorkerResponse {
  id: string;
  type: 'SUCCESS' | 'ERROR';
  data?: any;
  error?: string;
}

/**
 * SQLite client wrapper that communicates with the Web Worker
 */
export class SqliteClient {
  private worker: Worker;
  private messageId = 0;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (reason: any) => void;
    }
  >();

  constructor() {
    this.worker = new Worker(new URL('./sqlite.worker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const { id, type, data, error } = event.data;
      const pending = this.pendingRequests.get(id);

      if (pending) {
        if (type === 'SUCCESS') {
          pending.resolve(data);
        } else {
          pending.reject(new Error(error || 'Unknown error'));
        }
        this.pendingRequests.delete(id);
      }
    };

    this.worker.onerror = error => {
      console.error('[SqliteClient] Worker error:', error);
    };
  }

  /**
   * Send a query message to the worker
   */
  private async sendMessage<T = any>(
    type: 'QUERY' | 'EXEC' | 'AUTO_CATEGORIZE_BATCH' | 'INSERT_TRANSACTIONS' | 'APPLY_BATCH_REVIEWS' | 'DEDUPLICATE_TRANSACTIONS' | 'CLEAR_ALL_DATA' | 'RESET_CORRUPT_DATABASE',
    sql: string,
    params: any[] = [],
    transactions?: ParsedTransaction[],
    transactionIds?: string[],
    reviews?: ReviewDecision[],
    expectedDuplicateRows?: number
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = String(++this.messageId);
      this.pendingRequests.set(id, { resolve, reject });

      const message: WorkerMessage = {
        id,
        type,
        sql,
        params,
        transactions,
        transactionIds,
        reviews,
        expectedDuplicateRows,
      };

      this.worker.postMessage(message);

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('SQLite query timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Execute a SELECT query
   */
  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return this.sendMessage('QUERY', sql, params);
  }

  /**
   * Execute an INSERT/UPDATE/DELETE statement
   */
  async exec(sql: string, params: any[] = []): Promise<{ rowsModified: number }> {
    return this.sendMessage('EXEC', sql, params);
  }

  async clearDatabase(): Promise<void> {
    await this.sendMessage('CLEAR_ALL_DATA', '', []);
  }

  async resetCorruptDatabase(): Promise<void> {
    await this.sendMessage('RESET_CORRUPT_DATABASE', '', []);
  }

  async autoCategorizeBatch(transactionIds: string[]): Promise<number> {
    let rowsModified = 0;
    for (let start = 0; start < transactionIds.length; start += 500) {
      const result = await this.sendMessage<{ rowsModified: number }>(
        'AUTO_CATEGORIZE_BATCH',
        '',
        [],
        undefined,
        transactionIds.slice(start, start + 500)
      );
      rowsModified += result.rowsModified;
    }
    return rowsModified;
  }

  /**
   * Insert transactions with duplicate handling via INSERT OR IGNORE
   */
  async insertTransactions(txs: ParsedTransaction[]): Promise<number> {
    if (txs.length === 0) return 0;
    const result = await this.sendMessage<{ rowsModified: number }>(
      'INSERT_TRANSACTIONS',
      '',
      [],
      txs
    );
    return result.rowsModified;
  }

  /**
   * Apply merchant rule and reclassify existing transactions for the party
   */
  async applyMerchantRule(partyName: string, category: StandardCategory): Promise<void> {
    await this.sendMessage(
      'APPLY_BATCH_REVIEWS',
      '',
      [],
      undefined,
      undefined,
      [{ partyName, category }]
    );
  }

  async applyBatchReviews(reviews: ReviewDecision[]): Promise<void> {
    await this.sendMessage(
      'APPLY_BATCH_REVIEWS',
      '',
      [],
      undefined,
      undefined,
      reviews
    );
  }

  /**
   * Get transactions with optional filters
   */
  async getTransactions(filters?: {
    month?: string;
    category?: string;
  }): Promise<ParsedTransaction[]> {
    let sql = 'SELECT * FROM transactions WHERE 1=1';
    const params: any[] = [];

    if (filters?.month) {
      sql += ' AND transaction_date LIKE ?';
      params.push(`${filters.month}%`);
    }

    if (filters?.category) {
      sql += ' AND category = ?';
      params.push(filters.category);
    }

    sql += ' ORDER BY transaction_date DESC';

    const rows = await this.query<any>(sql, params);

    return rows.map(row => ({
      id: row.id,
      sourceType: row.source_type,
      transactionDate: row.transaction_date,
      transactionTime: row.transaction_time,
      rawDescription: row.raw_description,
      cleanPartyName: row.clean_party_name,
      amount: row.amount,
      flowType: row.flow_type,
      category: row.category as StandardCategory,
      confidenceScore: row.confidence_score,
      needsUserReview: Boolean(row.requires_review),
      classificationReason: row.classification_reason,
      scope: row.scope === 'home' ? 'home' : 'self',
      utrReference: row.utr_reference,
    }));
  }

  /**
   * Save a merchant rule (insert or replace)
   */
  async saveMerchantRule(rule: MerchantRule): Promise<number> {
    await this.applyMerchantRule(rule.pattern, rule.category);
    return 1;
  }

  /**
   * Get all merchant rules
   */
  async getAllRules(): Promise<MerchantRule[]> {
    const sql = 'SELECT pattern, category FROM merchant_rules ORDER BY LENGTH(pattern) DESC';
    const rows = await this.query<any>(sql);

    return rows.map(row => ({
      pattern: row.pattern,
      category: row.category as StandardCategory,
    }));
  }

  /**
   * Update a transaction's category
   */
  async updateTransactionCategory(
    id: string,
    newCategory: StandardCategory,
    reason?: string,
    flowType?: FlowType
  ): Promise<number> {
    const sql = `
      UPDATE transactions
      SET category = ?, classification_reason = ?,
          flow_type = COALESCE(?, flow_type), requires_review = 0
      WHERE id = ?
    `;

    const result = await this.exec(sql, [newCategory, reason || '', flowType || null, id]);
    return result.rowsModified;
  }

  /**
   * Find transactions matching a pattern
   */
  async findTransactionsByParty(partyName: string): Promise<ParsedTransaction[]> {
    const sql = `
      SELECT * FROM transactions
      WHERE clean_party_name LIKE ?
      ORDER BY transaction_date DESC
    `;

    const rows = await this.query<any>(sql, [`%${partyName}%`]);

    return rows.map(row => ({
      id: row.id,
      sourceType: row.source_type,
      transactionDate: row.transaction_date,
      transactionTime: row.transaction_time,
      rawDescription: row.raw_description,
      cleanPartyName: row.clean_party_name,
      amount: row.amount,
      flowType: row.flow_type,
      category: row.category as StandardCategory,
      confidenceScore: row.confidence_score,
      needsUserReview: Boolean(row.requires_review),
      classificationReason: row.classification_reason,
      scope: row.scope === 'home' ? 'home' : 'self',
      utrReference: row.utr_reference,
    }));
  }

  /**
   * Get transaction count
   */
  async getTransactionCount(): Promise<number> {
    const result = await this.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM transactions'
    );
    return result[0]?.count || 0;
  }

  async getDuplicateReport(): Promise<DuplicateReport> {
    const duplicateGroupsSql = `
      SELECT
        'UTR event' AS kind,
        UPPER(TRIM(utr_reference)) AS groupKey,
        COUNT(*) AS transactionCount,
        COUNT(DISTINCT category) AS categoryVariantCount,
        COUNT(DISTINCT scope) AS scopeVariantCount,
        COUNT(DISTINCT clean_party_name) AS payeeVariantCount,
        COUNT(DISTINCT amount) AS amountVariantCount,
        COUNT(DISTINCT transaction_date) AS dateVariantCount,
        COUNT(DISTINCT source_type) AS sourceVariantCount,
        COUNT(DISTINCT raw_description) AS descriptionVariantCount,
        GROUP_CONCAT(DISTINCT transaction_date) AS dates,
        GROUP_CONCAT(DISTINCT amount) AS amounts,
        GROUP_CONCAT(DISTINCT SUBSTR(raw_description, 1, 100)) AS descriptionSamples,
        GROUP_CONCAT(DISTINCT category) AS categories,
        GROUP_CONCAT(DISTINCT scope) AS scopes,
        GROUP_CONCAT(DISTINCT clean_party_name) AS payees
      FROM transactions
      WHERE utr_reference IS NOT NULL AND TRIM(utr_reference) != ''
      GROUP BY
        UPPER(TRIM(utr_reference)),
        source_type,
        transaction_date,
        COALESCE(transaction_time, ''),
        UPPER(TRIM(clean_party_name)),
        amount,
        flow_type,
        UPPER(TRIM(raw_description))
      HAVING COUNT(*) > 1

      UNION ALL

      SELECT
        'Fingerprint' AS kind,
        source_type || ' · ' || transaction_date || ' · ' ||
          COALESCE(transaction_time, 'no time') || ' · ' ||
          UPPER(TRIM(clean_party_name)) || ' · ₹' || amount || ' · ' ||
          flow_type AS groupKey,
        COUNT(*) AS transactionCount,
        COUNT(DISTINCT category) AS categoryVariantCount,
        COUNT(DISTINCT scope) AS scopeVariantCount,
        COUNT(DISTINCT clean_party_name) AS payeeVariantCount,
        COUNT(DISTINCT amount) AS amountVariantCount,
        COUNT(DISTINCT transaction_date) AS dateVariantCount,
        COUNT(DISTINCT source_type) AS sourceVariantCount,
        COUNT(DISTINCT raw_description) AS descriptionVariantCount,
        GROUP_CONCAT(DISTINCT transaction_date) AS dates,
        GROUP_CONCAT(DISTINCT amount) AS amounts,
        GROUP_CONCAT(DISTINCT SUBSTR(raw_description, 1, 100)) AS descriptionSamples,
        GROUP_CONCAT(DISTINCT category) AS categories,
        GROUP_CONCAT(DISTINCT scope) AS scopes,
        GROUP_CONCAT(DISTINCT clean_party_name) AS payees
      FROM transactions
      WHERE utr_reference IS NULL OR TRIM(utr_reference) = ''
      GROUP BY
        source_type,
        transaction_date,
        COALESCE(transaction_time, ''),
        UPPER(TRIM(clean_party_name)),
        amount,
        flow_type,
        UPPER(TRIM(raw_description))
      HAVING COUNT(*) > 1
    `;

    const [summary, groups] = await Promise.all([
      this.query<DuplicateReportSummary>(`
        SELECT
          kind,
          COUNT(*) AS duplicateGroups,
          SUM(transactionCount) AS rowsInGroups,
          SUM(transactionCount - 1) AS removableRows,
          SUM(CASE WHEN categoryVariantCount > 1 THEN 1 ELSE 0 END) AS categoryConflictGroups,
          SUM(CASE WHEN scopeVariantCount > 1 THEN 1 ELSE 0 END) AS scopeConflictGroups,
          SUM(CASE WHEN payeeVariantCount > 1 THEN 1 ELSE 0 END) AS payeeConflictGroups,
          SUM(CASE WHEN amountVariantCount > 1 THEN 1 ELSE 0 END) AS amountConflictGroups,
          SUM(CASE WHEN dateVariantCount > 1 THEN 1 ELSE 0 END) AS dateConflictGroups,
          SUM(CASE WHEN sourceVariantCount > 1 THEN 1 ELSE 0 END) AS sourceConflictGroups,
          SUM(CASE WHEN descriptionVariantCount > 1 THEN 1 ELSE 0 END) AS descriptionConflictGroups
        FROM (${duplicateGroupsSql})
        GROUP BY kind
        ORDER BY kind
      `),
      this.query<DuplicateGroupReport>(`
        SELECT
          kind,
          groupKey,
          transactionCount,
          transactionCount - 1 AS removableRows,
          categoryVariantCount,
          scopeVariantCount,
          payeeVariantCount,
          amountVariantCount,
          dateVariantCount,
          sourceVariantCount,
          descriptionVariantCount,
          dates,
          amounts,
          descriptionSamples,
          categories,
          scopes,
          payees
        FROM (${duplicateGroupsSql})
        ORDER BY
          categoryVariantCount DESC,
          scopeVariantCount DESC,
          payeeVariantCount DESC,
          amountVariantCount DESC,
          dateVariantCount DESC,
          sourceVariantCount DESC,
          descriptionVariantCount DESC,
          transactionCount DESC,
          kind,
          groupKey
        LIMIT 25
      `),
    ]);

    return { summary, groups };
  }

  async deduplicateTransactions(expectedDuplicateRows: number): Promise<number> {
    const result = await this.sendMessage<{ rowsModified: number }>(
      'DEDUPLICATE_TRANSACTIONS',
      '',
      [],
      undefined,
      undefined,
      undefined,
      expectedDuplicateRows
    );
    return result.rowsModified;
  }

  /**
   * Save a user setting (insert or replace)
   */
  async saveUserSetting(key: string, value: string): Promise<void> {
    await this.exec(
      `INSERT INTO user_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  }

  /**
   * Get a user setting by key
   */
  async getUserSetting(key: string): Promise<string | null> {
    const rows = await this.query<any>(`SELECT value FROM user_settings WHERE key = ? LIMIT 1`, [key]);
    return rows[0]?.value ?? null;
  }

  /**
   * Get all user settings
   */
  async getAllUserSettings(): Promise<Record<string, string>> {
    const rows = await this.query<any>(`SELECT key, value FROM user_settings`);
    return rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {} as Record<string, string>);
  }

  /**
   * Close the worker (cleanup)
   */
  dispose(): void {
    this.worker.terminate();
  }
}

// Export singleton instance
let sqliteClientInstance: SqliteClient | null = null;

export function getSqliteClient(): SqliteClient {
  if (!sqliteClientInstance) {
    sqliteClientInstance = new SqliteClient();
  }
  return sqliteClientInstance;
}
