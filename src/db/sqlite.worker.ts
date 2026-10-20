/// <reference lib="webworker" />

import type { ParsedTransaction } from '../types/finance';

declare const sqlite3: any;

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

interface ReviewDecision {
  id?: string;
  partyName: string;
  category: string;
  scope?: 'self' | 'home';
  applyGlobally?: boolean;
}

interface WorkerResponse {
  id: string;
  type: 'SUCCESS' | 'ERROR';
  data?: any;
  error?: string;
}

interface SQLiteStatement {
  bind(params: unknown[]): void;
  step(): void;
  reset(): void;
  finalize(): void;
}

interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  changes(): number;
  close(): void;
}

let db: any;
let initPromise: Promise<void> | null = null;

async function ensureDatabaseInitialized() {
  if (!initPromise) {
    initPromise = initializeDatabase();
  }
  await initPromise;
}

/**
 * Initialize SQLite database
 * Uses OPFS (Origin Private File System) if available, otherwise in-memory
 */
async function initializeDatabase(resetExisting = false) {
  try {
    if (self.crossOriginIsolated !== true) {
      console.error(
        'Cross-Origin Isolation missing: COOP/COEP headers required for OPFS persistence'
      );
    }

    // Dynamically import sqlite3 wasm module and initialize it
    const sqliteModule = await import('@sqlite.org/sqlite-wasm');
    const initSqlite = sqliteModule.default || sqliteModule;

    // Serve the package's wasm assets from the same origin so the browser can
    // satisfy COOP/COEP and avoid cross-origin fetch failures during upload.
    const sqlite3 = await (initSqlite as any)({
      locateFile: (file: string) => {
        if (file === 'sqlite3.wasm') return '/sqlite-wasm/sqlite3.wasm';
        if (file === 'sqlite3-worker1.mjs') return '/sqlite-wasm/sqlite3-worker1.mjs';
        return `/sqlite-wasm/${file}`;
      },
    });

    // Try to use OPFS if available, otherwise use memory DB
    if (
      self.crossOriginIsolated === true &&
      typeof navigator !== 'undefined' &&
      (navigator as any).storage &&
      (navigator as any).storage.getDirectory
    ) {
      try {
        await (navigator as any).storage.getDirectory();
        const databaseName = resetExisting
          ? 'file:payment-analyser.db?delete-before-open=1'
          : 'payment-analyser.db';
        db = new sqlite3.oo1.OpfsDb(databaseName, 'c');
        console.log('[SQLite] Opened persistent OPFS database:', db.filename);
      } catch (opfsErr) {
        console.error(
          '[SQLite] OPFS initialization failed; data will not persist across page refreshes:',
          opfsErr
        );
        db = new sqlite3.oo1.DB();
        console.warn('[SQLite] Falling back to an in-memory database');
      }
    } else {
      db = new sqlite3.oo1.DB();
      console.warn('[SQLite] OPFS unavailable, using an in-memory database');
    }

    // Run migrations
    await runMigrations();
  } catch (error) {
    console.error('[SQLite] Initialization failed:', error);
    throw error;
  }
}

/**
 * Run table setup migrations
 */
async function runMigrations() {
  const migrations = [
    `
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      transaction_date TEXT NOT NULL,
      transaction_time TEXT,
      raw_description TEXT NOT NULL,
      clean_party_name TEXT NOT NULL,
      amount REAL NOT NULL,
      flow_type TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence_score REAL NOT NULL,
      requires_review INTEGER DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'self' CHECK (scope IN ('self', 'home')),
      classification_reason TEXT,
      utr_reference TEXT
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS user_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS merchant_rules (
      pattern TEXT PRIMARY KEY,
      category TEXT NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS payee_category_rules (
      payee_name TEXT PRIMARY KEY COLLATE NOCASE,
      category TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'self' CHECK (scope IN ('self', 'home'))
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS description_category_rules (
      keyword TEXT PRIMARY KEY COLLATE NOCASE,
      category TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0
    )
    `,
    `CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(transaction_date)`,
    `CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category)`,
    `CREATE INDEX IF NOT EXISTS idx_tx_normalized_payee ON transactions(UPPER(TRIM(COALESCE(clean_party_name, ''))))`,
  ];

  for (const sql of migrations) {
    db.exec(sql);
  }

  const payeeRuleColumns = executeQuery('PRAGMA table_info(payee_category_rules)');
  if (!payeeRuleColumns.some(column => column.name === 'scope')) {
    db.exec(
      "ALTER TABLE payee_category_rules ADD COLUMN scope TEXT NOT NULL DEFAULT 'self' CHECK (scope IN ('self', 'home'))"
    );
  }

  const transactionColumns = executeQuery('PRAGMA table_info(transactions)');
  if (!transactionColumns.some(column => column.name === 'scope')) {
    db.exec(
      "ALTER TABLE transactions ADD COLUMN scope TEXT NOT NULL DEFAULT 'self' CHECK (scope IN ('self', 'home'))"
    );
  }

  if (!transactionColumns.some(column => column.name === 'requires_review')) {
    db.exec('ALTER TABLE transactions ADD COLUMN requires_review INTEGER NOT NULL DEFAULT 0');
    if (transactionColumns.some(column => column.name === 'needs_user_review')) {
      db.exec('UPDATE transactions SET requires_review = needs_user_review');
    }
  }

  const merchantRuleColumns = executeQuery('PRAGMA table_info(merchant_rules)');
  if (
    merchantRuleColumns.some(column => column.name === 'assigned_category') ||
    !merchantRuleColumns.some(column => column.name === 'category')
  ) {
    const hasCategory = merchantRuleColumns.some(column => column.name === 'category');
    db.exec('ALTER TABLE merchant_rules RENAME TO merchant_rules_legacy');
    db.exec(`
      CREATE TABLE merchant_rules (
        pattern TEXT PRIMARY KEY,
        category TEXT NOT NULL
      )
    `);
    const categoryColumn = hasCategory ? 'category' : 'assigned_category';
    if (merchantRuleColumns.some(column => column.name === categoryColumn)) {
      db.exec(`
        INSERT OR IGNORE INTO merchant_rules (pattern, category)
        SELECT pattern, ${categoryColumn} FROM merchant_rules_legacy
      `);
    }
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS merchant_rules (
        pattern TEXT PRIMARY KEY,
        category TEXT NOT NULL
      )
    `);
  }

  seedDefaultMerchantRules(db);
  migrateLegacyPayeeRules(db);
  seedDescriptionCategoryRules(db);
  db.exec(`
    UPDATE transactions
    SET category = COALESCE(
          (
            SELECT rule.category
            FROM payee_category_rules AS rule
            WHERE UPPER(TRIM(COALESCE(transactions.clean_party_name, ''))) =
                  UPPER(TRIM(rule.payee_name))
              AND rule.category != 'Personal Transfer'
            LIMIT 1
          ),
          (
          SELECT rule.category
          FROM merchant_rules AS rule
          WHERE INSTR(
            UPPER(COALESCE(transactions.clean_party_name, '')),
            UPPER(rule.pattern)
          ) > 0
          ORDER BY LENGTH(rule.pattern) DESC
          LIMIT 1
          ),
          category
        ),
        flow_type = CASE
          WHEN COALESCE(
            (
              SELECT rule.category
              FROM payee_category_rules AS rule
              WHERE UPPER(TRIM(COALESCE(transactions.clean_party_name, ''))) =
                    UPPER(TRIM(rule.payee_name))
                AND rule.category != 'Personal Transfer'
              LIMIT 1
            ),
            (
            SELECT rule.category
            FROM merchant_rules AS rule
            WHERE INSTR(
              UPPER(COALESCE(transactions.clean_party_name, '')),
              UPPER(rule.pattern)
            ) > 0
            ORDER BY LENGTH(rule.pattern) DESC
            LIMIT 1
            )
          ) = 'Internal Transfer' THEN 'INTERNAL_TRANSFER'
            WHEN COALESCE(
              (
                SELECT rule.category
                FROM payee_category_rules AS rule
                WHERE UPPER(TRIM(COALESCE(transactions.clean_party_name, ''))) =
                      UPPER(TRIM(rule.payee_name))
                  AND rule.category != 'Personal Transfer'
                LIMIT 1
              ),
              (
                SELECT rule.category
                FROM merchant_rules AS rule
                WHERE INSTR(
                  UPPER(COALESCE(transactions.clean_party_name, '')),
                  UPPER(rule.pattern)
                ) > 0
                ORDER BY LENGTH(rule.pattern) DESC
                LIMIT 1
              )
            ) = 'Salary & Income' THEN 'INCOME'
            WHEN COALESCE(
              (
                SELECT rule.category
                FROM payee_category_rules AS rule
                WHERE UPPER(TRIM(COALESCE(transactions.clean_party_name, ''))) =
                      UPPER(TRIM(rule.payee_name))
                  AND rule.category != 'Personal Transfer'
                LIMIT 1
              ),
              (
                SELECT rule.category
                FROM merchant_rules AS rule
                WHERE INSTR(
                  UPPER(COALESCE(transactions.clean_party_name, '')),
                  UPPER(rule.pattern)
                ) > 0
                ORDER BY LENGTH(rule.pattern) DESC
                LIMIT 1
              )
            ) = 'Personal Transfer' THEN
              CASE
                WHEN UPPER(raw_description) LIKE '%CREDIT%'
                  OR UPPER(raw_description) LIKE '%RECEIVED%'
                  OR UPPER(raw_description) LIKE '%CREDITED%'
                  OR UPPER(raw_description) LIKE '%INCOME%'
                  OR UPPER(raw_description) LIKE '%REFUND%'
                  OR UPPER(raw_description) LIKE '%REFUNDED%'
                  OR UPPER(raw_description) LIKE '%REVERSAL%'
                THEN 'INCOME'
                ELSE 'EXPENSE'
              END
            WHEN flow_type = 'INTERNAL_TRANSFER' THEN
            CASE
              WHEN UPPER(raw_description) LIKE '%CREDIT%'
                OR UPPER(raw_description) LIKE '%RECEIVED%'
                OR UPPER(raw_description) LIKE '%CREDITED%'
                OR UPPER(raw_description) LIKE '%INCOME%'
                OR UPPER(raw_description) LIKE '%REFUND%'
                OR UPPER(raw_description) LIKE '%REFUNDED%'
                OR UPPER(raw_description) LIKE '%REVERSAL%'
              THEN 'INCOME'
              ELSE 'EXPENSE'
            END
          ELSE flow_type
        END,
        scope = COALESCE(
          (
            SELECT rule.scope
            FROM payee_category_rules AS rule
            WHERE UPPER(TRIM(COALESCE(transactions.clean_party_name, ''))) =
                  UPPER(TRIM(rule.payee_name))
              AND rule.category != 'Personal Transfer'
            LIMIT 1
          ),
          scope
        ),
        confidence_score = 0.9,
        requires_review = 0,
        classification_reason = CASE
          WHEN EXISTS (
            SELECT 1
            FROM payee_category_rules AS rule
            WHERE UPPER(TRIM(COALESCE(transactions.clean_party_name, ''))) =
                  UPPER(TRIM(rule.payee_name))
              AND rule.category != 'Personal Transfer'
          ) THEN 'Matched saved payee category'
          ELSE 'Matched merchant rule'
        END
    WHERE (requires_review = 1 OR category = 'Uncategorized' OR flow_type = 'INTERNAL_TRANSFER')
      AND COALESCE(category, '') != 'Personal Transfer'
      AND (
        EXISTS (
          SELECT 1
          FROM merchant_rules AS rule
          WHERE INSTR(
            UPPER(COALESCE(transactions.clean_party_name, '')),
            UPPER(rule.pattern)
          ) > 0
        )
        OR EXISTS (
          SELECT 1
          FROM payee_category_rules AS rule
          WHERE UPPER(TRIM(COALESCE(transactions.clean_party_name, ''))) =
                UPPER(TRIM(rule.payee_name))
            AND rule.category != 'Personal Transfer'
        )
      )
  `);
  db.exec(`
    UPDATE transactions
    SET category = CASE
          WHEN category != 'Internal Transfer' THEN category
          WHEN amount <= 150 THEN 'Small Daily Spends / Misc'
          ELSE 'Uncategorized'
        END,
        flow_type = CASE
          WHEN UPPER(raw_description) LIKE '%CREDIT%'
            OR UPPER(raw_description) LIKE '%RECEIVED%'
            OR UPPER(raw_description) LIKE '%CREDITED%'
            OR UPPER(raw_description) LIKE '%INCOME%'
            OR UPPER(raw_description) LIKE '%REFUND%'
            OR UPPER(raw_description) LIKE '%REFUNDED%'
            OR UPPER(raw_description) LIKE '%REVERSAL%'
          THEN 'INCOME'
          ELSE 'EXPENSE'
        END,
        confidence_score = CASE
          WHEN category != 'Internal Transfer' THEN confidence_score
          WHEN amount <= 150 THEN 0.7
          ELSE 0.3
        END,
        requires_review = CASE
          WHEN category != 'Internal Transfer' THEN requires_review
          WHEN amount <= 150 THEN 0
          ELSE 1
        END,
        classification_reason = CASE
          WHEN category != 'Internal Transfer' THEN classification_reason
          WHEN amount <= 150 THEN 'Unmapped transaction of ₹150 or less'
          ELSE 'Unmapped transaction over ₹150, requires user review'
        END
    WHERE (category = 'Internal Transfer' OR flow_type = 'INTERNAL_TRANSFER')
      AND NOT EXISTS (
        SELECT 1
        FROM merchant_rules AS rule
        WHERE rule.category = 'Internal Transfer'
          AND INSTR(
            UPPER(COALESCE(transactions.clean_party_name, '')),
            UPPER(rule.pattern)
          ) > 0
      )
      AND COALESCE(classification_reason, '') NOT IN ('User batch review', 'User manual override')
  `);
  db.exec(`
    UPDATE transactions
    SET flow_type = CASE
      WHEN UPPER(raw_description) LIKE '%PAID TO ' || UPPER(COALESCE(clean_party_name, '')) || '%'
      THEN 'EXPENSE'
      WHEN UPPER(raw_description) LIKE '%RECEIVED FROM ' || UPPER(COALESCE(clean_party_name, '')) || '%'
      THEN 'INCOME'
      WHEN UPPER(raw_description) LIKE '%PAID BY%'
        OR UPPER(raw_description) LIKE '%DEBITED%'
        OR UPPER(raw_description) LIKE '%DEBIT%'
      THEN 'EXPENSE'
      ELSE flow_type
    END
    WHERE source_type = 'GPAY'
      AND (
        (flow_type = 'INCOME' AND (
          UPPER(raw_description) LIKE '%PAID TO ' || UPPER(COALESCE(clean_party_name, '')) || '%'
          OR UPPER(raw_description) LIKE '%PAID BY%'
          OR UPPER(raw_description) LIKE '%DEBITED%'
          OR UPPER(raw_description) LIKE '%DEBIT%'
        ))
        OR (flow_type = 'EXPENSE' AND UPPER(raw_description) LIKE '%RECEIVED FROM ' || UPPER(COALESCE(clean_party_name, '')) || '%')
      )
  `);
  db.exec('DROP INDEX IF EXISTS idx_tx_review');
  db.exec('CREATE INDEX idx_tx_review ON transactions(requires_review)');
  db.exec('DROP INDEX IF EXISTS idx_tx_dedupe_fingerprint');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tx_dedupe_fingerprint_v2
    ON transactions(
      source_type,
      transaction_date,
      COALESCE(transaction_time, ''),
      UPPER(TRIM(clean_party_name)),
      amount,
      flow_type,
      UPPER(TRIM(raw_description))
    )
    WHERE utr_reference IS NULL OR TRIM(utr_reference) = ''
  `);
  db.exec('DROP INDEX IF EXISTS idx_tx_unique_utr');
  const duplicateUtrEventGroups = executeQuery(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT UPPER(TRIM(utr_reference))
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
    )
  `)[0]?.count ?? 0;
  if (duplicateUtrEventGroups === 0) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_unique_utr_event
      ON transactions(
        UPPER(TRIM(utr_reference)),
        source_type,
        transaction_date,
        COALESCE(transaction_time, ''),
        UPPER(TRIM(clean_party_name)),
        amount,
        flow_type,
        UPPER(TRIM(raw_description))
      )
      WHERE utr_reference IS NOT NULL AND TRIM(utr_reference) != ''
    `);
  } else {
    console.warn(
      `[SQLite] Found ${duplicateUtrEventGroups} existing duplicate UTR event group(s); preserving existing rows and enforcing import-time deduplication`
    );
  }

  // Remove legacy hash-based dedupe if an older DB still has it.
  try {
    db.exec(`DROP INDEX IF EXISTS idx_tx_composite_hash`);
  } catch (e) {
    // ignore
  }

  try {
    db.exec(`ALTER TABLE transactions DROP COLUMN composite_hash`);
  } catch (e) {
    // ignore as older SQLite builds may not support dropping columns
  }

  const pendingClassificationIds = executeQuery(
    `SELECT id FROM transactions
     WHERE requires_review = 1
        OR category = 'Uncategorized'
        OR classification_reason = 'Unmapped transaction of ₹150 or less'`
  ).map((row: { id: string }) => row.id);
  autoCategorizeBatch(db, pendingClassificationIds);
}

function seedDefaultMerchantRules(database: SQLiteDatabase) {
  database.exec(`
    INSERT OR IGNORE INTO merchant_rules (pattern, category) VALUES
      ('SWIGGY', 'Food & Dining'),
      ('ZOMATO', 'Food & Dining'),
      ('DOMINO', 'Food & Dining'),
      ('PIZZA HUT', 'Food & Dining'),
      ('MCDONALDS', 'Food & Dining'),
      ('STARBUCKS', 'Food & Dining'),
      ('BLINKIT', 'Groceries'),
      ('ZEPTO', 'Groceries'),
      ('INSTAMART', 'Groceries'),
      ('BIGBASKET', 'Groceries'),
      ('DMART', 'Groceries'),
      ('AMAZON', 'Shopping'),
      ('FLIPKART', 'Shopping'),
      ('MYNTRA', 'Shopping'),
      ('AJIO', 'Shopping'),
      ('UBER', 'Commute'),
      ('OLA', 'Commute'),
      ('RAPIDO', 'Commute'),
      ('IRCTC', 'Commute'),
      ('REDBUS', 'Commute'),
      ('AIRTEL', 'Bills & Utilities'),
      ('JIO', 'Bills & Utilities'),
      ('BESCOM', 'Bills & Utilities'),
      ('TSSPDCL', 'Bills & Utilities'),
      ('BSNL', 'Bills & Utilities')
  `);
}

function migrateLegacyPayeeRules(database: SQLiteDatabase) {
  const builtInPatterns = [
    'SWIGGY', 'ZOMATO', 'DOMINO', 'PIZZA HUT', 'MCDONALDS', 'STARBUCKS',
    'BLINKIT', 'ZEPTO', 'INSTAMART', 'BIGBASKET', 'DMART', 'AMAZON',
    'FLIPKART', 'MYNTRA', 'AJIO', 'UBER', 'OLA', 'RAPIDO', 'IRCTC',
    'REDBUS', 'AIRTEL', 'JIO', 'BESCOM', 'TSSPDCL', 'BSNL',
  ];
  const placeholders = builtInPatterns.map(() => '?').join(', ');
  const customRules = executeQuery(
    `SELECT pattern, category FROM merchant_rules WHERE UPPER(TRIM(pattern)) NOT IN (${placeholders})`,
    builtInPatterns
  ) as Array<{ pattern: string; category: string }>;
  if (customRules.length === 0) return;

  database.exec('BEGIN IMMEDIATE');
  const saveRule = database.prepare(`
    INSERT OR IGNORE INTO payee_category_rules (payee_name, category)
    VALUES (?, ?)
  `);
  const removeLegacyRule = database.prepare('DELETE FROM merchant_rules WHERE pattern = ?');
  try {
    for (const rule of customRules) {
      saveRule.bind([rule.pattern.trim(), rule.category]);
      saveRule.step();
      saveRule.reset();
      removeLegacyRule.bind([rule.pattern]);
      removeLegacyRule.step();
      removeLegacyRule.reset();
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('[SQLite] Failed to roll back legacy payee-rule migration:', rollbackError);
    }
    throw error;
  } finally {
    saveRule.finalize();
    removeLegacyRule.finalize();
  }
}

function seedDescriptionCategoryRules(database: SQLiteDatabase) {
  database.exec(`
    INSERT OR IGNORE INTO description_category_rules (keyword, category, priority) VALUES
      ('RENT', 'Bills & Utilities', 10),
      ('WI-FI', 'Bills & Utilities', 10),
      ('WIFI', 'Bills & Utilities', 10),
      ('FIBER', 'Bills & Utilities', 8),
      ('BROADBAND', 'Bills & Utilities', 10),
      ('ELECTRICITY', 'Bills & Utilities', 10),
      ('POWER', 'Bills & Utilities', 8),
      ('POWER BILL', 'Bills & Utilities', 8),
      ('WATER BILL', 'Bills & Utilities', 10),
      ('WATER', 'Bills & Utilities', 7),
      ('GAS BILL', 'Bills & Utilities', 10),
      ('GAS', 'Bills & Utilities', 7),
      ('MAINTENANCE', 'Bills & Utilities', 8),
      ('UTILITY BILL', 'Bills & Utilities', 10),
      ('BILL PAYMENT', 'Bills & Utilities', 5),
      ('PHARMACY', 'Medical', 7),
      ('CHEMIST', 'Medical', 7),
      ('HOSPITAL', 'Medical', 7),
      ('CLINIC', 'Medical', 7),
      ('LAB', 'Medical', 5),
      ('MART', 'Groceries', 6),
      ('GROCERY', 'Groceries', 7),
      ('SUPERMARKET', 'Groceries', 7),
      ('KIRANA', 'Groceries', 7),
      ('FOOD', 'Food & Dining', 6),
      ('RESTAURANT', 'Food & Dining', 7),
      ('CAFE', 'Food & Dining', 7),
      ('BAKERY', 'Food & Dining', 7),
      ('CHAI', 'Food & Dining', 5),
      ('PETROL', 'Commute', 7),
      ('FUEL', 'Commute', 6),
      ('FASTAG', 'Commute', 7)
  `);
}

/**
 * Execute a query and return results
 */
function executeQuery(sql: string, params: any[] = []): any[] {
  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }

    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.get({}));
    }
    stmt.finalize();

    return results;
  } catch (error) {
    console.error('[SQLite] Query error:', error, 'SQL:', sql);
    throw error;
  }
}

/**
 * Execute a statement (INSERT, UPDATE, DELETE)
 */
function executeStatement(sql: string, params: any[] = []): number {
  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }
    stmt.step();
    stmt.finalize();

    return db.changes();
  } catch (error) {
    console.error('[SQLite] Statement error:', error, 'SQL:', sql);
    throw error;
  }
}

function autoCategorizeBatch(database: SQLiteDatabase, transactionIds: string[]): number {
  if (transactionIds.length === 0) return 0;
  if (transactionIds.length > 500) {
    let rowsModified = 0;
    for (let start = 0; start < transactionIds.length; start += 500) {
      rowsModified += autoCategorizeBatch(database, transactionIds.slice(start, start + 500));
    }
    return rowsModified;
  }
  inferUtilityPayees(database, transactionIds);
  const idPlaceholders = transactionIds.map(() => '?').join(', ');
  const sql = `
    WITH matches AS MATERIALIZED (
      SELECT
        tx.id,
        tx.amount,
        tx.raw_description,
        tx.flow_type,
        (
          SELECT rule.scope
          FROM payee_category_rules AS rule
          WHERE UPPER(TRIM(tx.clean_party_name)) = UPPER(TRIM(rule.payee_name))
            AND rule.category != 'Personal Transfer'
          LIMIT 1
        ) AS exact_payee_scope,
        (
          SELECT rule.category
          FROM payee_category_rules AS rule
          WHERE UPPER(TRIM(tx.clean_party_name)) = UPPER(TRIM(rule.payee_name))
            AND rule.category != 'Personal Transfer'
          LIMIT 1
        ) AS exact_payee_category,
        (
          SELECT rule.category
          FROM merchant_rules AS rule
          WHERE INSTR(UPPER(COALESCE(tx.clean_party_name, '')), UPPER(rule.pattern)) > 0
            AND rule.category != 'Personal Transfer'
          ORDER BY LENGTH(rule.pattern) DESC
          LIMIT 1
        ) AS merchant_category,
        (
          SELECT rule.category
          FROM description_category_rules AS rule
          WHERE rule.category != 'Personal Transfer'
            AND CASE
            WHEN UPPER(rule.keyword) = 'RENT' THEN INSTR(
              ' ' || REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                UPPER(COALESCE(tx.clean_party_name, '') || ' ' || COALESCE(tx.raw_description, '')),
                '-', ' '), '/', ' '), '.', ' '), ':', ' '), ',', ' ') || ' ',
              ' RENT '
            ) > 0
            ELSE INSTR(
              UPPER(COALESCE(tx.clean_party_name, '') || ' ' || COALESCE(tx.raw_description, '')),
              UPPER(rule.keyword)
            ) > 0
          END
          ORDER BY rule.priority DESC, LENGTH(rule.keyword) DESC
          LIMIT 1
        ) AS description_category
      FROM transactions AS tx
      WHERE tx.id IN (${idPlaceholders})
        AND COALESCE(tx.classification_reason, '') NOT IN ('User manual override', 'User batch review')
    ),
    classified AS MATERIALIZED (
      SELECT
        *,
        COALESCE(exact_payee_category, merchant_category, description_category) AS matched_category,
        CASE
          WHEN exact_payee_category IS NOT NULL THEN 'Matched saved payee category'
          WHEN merchant_category IS NOT NULL THEN 'Matched merchant rule'
          WHEN description_category IS NOT NULL THEN 'Matched description keyword rule'
          WHEN amount <= 150 THEN 'Unmapped transaction of ₹150 or less'
          ELSE 'Unmapped transaction over ₹150, requires user review'
        END AS reason
      FROM matches
    )
    UPDATE transactions
    SET category = COALESCE(
          classified.matched_category,
          CASE WHEN classified.amount <= 150 THEN 'Small Daily Spends / Misc' ELSE 'Uncategorized' END
        ),
        confidence_score = CASE
          WHEN classified.exact_payee_category IS NOT NULL
            OR classified.merchant_category IS NOT NULL THEN 0.9
          WHEN classified.description_category IS NOT NULL THEN 0.8
          WHEN classified.amount <= 150 THEN 0.7
          ELSE 0.3
        END,
        classification_reason = classified.reason,
        scope = COALESCE(classified.exact_payee_scope, scope),
        requires_review = CASE
          WHEN classified.amount > 150 AND classified.matched_category IS NULL THEN 1
          ELSE 0
        END,
        flow_type = CASE
      WHEN classified.matched_category = 'Internal Transfer'
        THEN 'INTERNAL_TRANSFER'
      WHEN classified.matched_category = 'Salary & Income'
        THEN 'INCOME'
      WHEN classified.matched_category = 'Personal Transfer'
        THEN CASE
          WHEN UPPER(classified.raw_description) LIKE '%CREDIT%'
            OR UPPER(classified.raw_description) LIKE '%RECEIVED%'
            OR UPPER(classified.raw_description) LIKE '%CREDITED%'
            OR UPPER(classified.raw_description) LIKE '%INCOME%'
            OR UPPER(classified.raw_description) LIKE '%REFUND%'
            OR UPPER(classified.raw_description) LIKE '%REFUNDED%'
            OR UPPER(classified.raw_description) LIKE '%REVERSAL%'
          THEN 'INCOME'
          ELSE 'EXPENSE'
        END
      WHEN classified.flow_type = 'INTERNAL_TRANSFER' AND classified.matched_category IS NOT NULL
        THEN CASE
          WHEN UPPER(classified.raw_description) LIKE '%CREDIT%'
            OR UPPER(classified.raw_description) LIKE '%RECEIVED%'
            OR UPPER(classified.raw_description) LIKE '%CREDITED%'
            OR UPPER(classified.raw_description) LIKE '%INCOME%'
            OR UPPER(classified.raw_description) LIKE '%REFUND%'
            OR UPPER(classified.raw_description) LIKE '%REFUNDED%'
            OR UPPER(classified.raw_description) LIKE '%REVERSAL%'
          THEN 'INCOME'
          ELSE 'EXPENSE'
        END
      ELSE classified.flow_type
        END
    FROM classified
    WHERE transactions.id = classified.id
  `;
  const statement = database.prepare(sql);
  try {
    statement.bind(transactionIds);
    statement.step();
    return database.changes();
  } finally {
    statement.finalize();
  }
}

function inferUtilityPayees(database: SQLiteDatabase, transactionIds: string[]): void {
  if (transactionIds.length === 0) return;
  const idPlaceholders = transactionIds.map(() => '?').join(', ');
  const statement = database.prepare(`
    UPDATE transactions
    SET clean_party_name = CASE
      WHEN UPPER(COALESCE(raw_description, '')) LIKE '%ELECTRIC%'
        OR UPPER(COALESCE(raw_description, '')) LIKE '%POWER%'
        THEN 'Electricity'
      WHEN UPPER(COALESCE(raw_description, '')) LIKE '%WI-FI%'
        OR UPPER(COALESCE(raw_description, '')) LIKE '%WIFI%'
        OR UPPER(COALESCE(raw_description, '')) LIKE '%FIBER%'
        OR UPPER(COALESCE(raw_description, '')) LIKE '%BROADBAND%'
        THEN 'Wi-Fi / Broadband'
      WHEN UPPER(COALESCE(raw_description, '')) LIKE '%GAS BILL%'
        THEN 'Gas'
      WHEN UPPER(COALESCE(raw_description, '')) LIKE '%WATER BILL%'
        THEN 'Water'
      WHEN UPPER(COALESCE(raw_description, '')) LIKE '%MAINTENANCE%'
        THEN 'Maintenance'
      ELSE clean_party_name
    END
    WHERE id IN (${idPlaceholders})
      AND (
        clean_party_name IS NULL
        OR TRIM(clean_party_name) = ''
        OR UPPER(TRIM(clean_party_name)) = 'UNKNOWN'
      )
  `);
  try {
    statement.bind(transactionIds);
    statement.step();
  } finally {
    statement.finalize();
  }
}

function applyBatchReviews(database: SQLiteDatabase, reviews: ReviewDecision[]): void {
  const categoryByPayee = new Map<string, { name: string; category: string; scope: 'self' | 'home' }>();
  const transactionReviews: ReviewDecision[] = [];
  for (const review of reviews) {
    if (review.id) {
      transactionReviews.push(review);
    }
    const key = review.partyName.trim().toUpperCase();
    if (review.category === 'Personal Transfer') {
      if (!review.id) {
        throw new Error('Personal Transfer must be assigned to a specific transaction');
      }
      continue;
    }
    if (review.applyGlobally === false) continue;
    if (!key) {
      if (review.id) continue;
      throw new Error('Cannot save a category rule for an empty payee name');
    }
    const existing = categoryByPayee.get(key);
    if (existing && (
      existing.category !== review.category ||
      existing.scope !== (review.scope || 'self')
    )) {
      throw new Error(
        `Choose one category and scope for all staged transactions from "${review.partyName}"`
      );
    }
    categoryByPayee.set(key, {
      name: review.partyName.trim(),
      category: review.category,
      scope: review.scope || 'self',
    });
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const saveRule = database.prepare(`
      INSERT INTO payee_category_rules (payee_name, category, scope)
      VALUES (?, ?, ?)
      ON CONFLICT(payee_name) DO UPDATE SET
        category = excluded.category,
        scope = excluded.scope
    `);
    const updatePayee = database.prepare(`
      UPDATE transactions
      SET category = ?,
          scope = ?,
          flow_type = CASE
            WHEN ? = 'Internal Transfer' THEN 'INTERNAL_TRANSFER'
            WHEN ? = 'Salary & Income' THEN 'INCOME'
            WHEN ? = 'Personal Transfer' THEN flow_type
            WHEN flow_type = 'INTERNAL_TRANSFER' THEN
              CASE
                WHEN UPPER(raw_description) LIKE '%CREDIT%'
                  OR UPPER(raw_description) LIKE '%RECEIVED%'
                  OR UPPER(raw_description) LIKE '%CREDITED%'
                  OR UPPER(raw_description) LIKE '%INCOME%'
                  OR UPPER(raw_description) LIKE '%REFUND%'
                  OR UPPER(raw_description) LIKE '%REFUNDED%'
                  OR UPPER(raw_description) LIKE '%REVERSAL%'
                THEN 'INCOME'
                ELSE 'EXPENSE'
              END
            ELSE flow_type
          END,
          confidence_score = 0.9,
          classification_reason = 'Matched saved payee category',
          requires_review = 0
      WHERE UPPER(TRIM(COALESCE(clean_party_name, ''))) = UPPER(TRIM(?))
        AND category != 'Personal Transfer'
    `);
    const updateScope = database.prepare('UPDATE transactions SET scope = ? WHERE id = ?');
    const updateTransaction = database.prepare(`
      UPDATE transactions
      SET category = ?,
          flow_type = CASE
            WHEN ? = 'Internal Transfer' THEN 'INTERNAL_TRANSFER'
            WHEN ? = 'Salary & Income' THEN 'INCOME'
            WHEN ? = 'Personal Transfer' THEN flow_type
            WHEN flow_type = 'INTERNAL_TRANSFER' THEN
              CASE
                WHEN UPPER(raw_description) LIKE '%CREDIT%'
                  OR UPPER(raw_description) LIKE '%RECEIVED%'
                  OR UPPER(raw_description) LIKE '%CREDITED%'
                  OR UPPER(raw_description) LIKE '%INCOME%'
                  OR UPPER(raw_description) LIKE '%REFUND%'
                  OR UPPER(raw_description) LIKE '%REFUNDED%'
                  OR UPPER(raw_description) LIKE '%REVERSAL%'
                THEN 'INCOME'
                ELSE 'EXPENSE'
              END
            ELSE flow_type
          END,
          confidence_score = 0.9,
          classification_reason = 'User manual override',
          requires_review = 0
      WHERE id = ?
    `);

    try {
      for (const { name: payeeName, category, scope } of categoryByPayee.values()) {
        saveRule.bind([payeeName, category, scope]);
        saveRule.step();
        saveRule.reset();
        updatePayee.bind([category, scope, category, category, category, payeeName]);
        updatePayee.step();
        updatePayee.reset();
      }
      for (const review of transactionReviews) {
        updateTransaction.bind([
          review.category,
          review.category,
          review.category,
          review.category,
          review.id,
        ]);
        updateTransaction.step();
        updateTransaction.reset();
        if (review.scope) {
          updateScope.bind([review.scope, review.id]);
          updateScope.step();
          updateScope.reset();
        }
      }
      database.exec('COMMIT');
    } finally {
      saveRule.finalize();
      updatePayee.finalize();
      updateScope.finalize();
      updateTransaction.finalize();
    }
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('[SQLite] Failed to roll back reviewed transactions:', rollbackError);
    }
    throw error;
  }
}

function insertTransactionsBatch(
  database: SQLiteDatabase,
  transactions: ParsedTransaction[]
): number {
  if (transactions.length === 0) return 0;

  const sql = `
    INSERT OR IGNORE INTO transactions
    (id, source_type, transaction_date, transaction_time, raw_description,
     clean_party_name, amount, flow_type, category, confidence_score,
     requires_review, scope, classification_reason, utr_reference)
    SELECT ${Array.from({ length: 14 }, () => '?').join(', ')}
    WHERE NOT EXISTS (
      SELECT 1
      FROM transactions AS existing
      WHERE (
        (
          ? IS NOT NULL
          AND TRIM(?) != ''
          AND existing.utr_reference IS NOT NULL
          AND TRIM(existing.utr_reference) != ''
          AND UPPER(TRIM(existing.utr_reference)) = UPPER(TRIM(?))
        )
        OR (
          (? IS NULL OR TRIM(?) = '')
          AND (existing.utr_reference IS NULL OR TRIM(existing.utr_reference) = '')
        )
      )
        AND existing.source_type = ?
        AND existing.transaction_date = ?
        AND COALESCE(existing.transaction_time, '') = COALESCE(?, '')
        AND UPPER(TRIM(existing.clean_party_name)) = UPPER(TRIM(?))
        AND existing.amount = ?
        AND existing.flow_type = ?
        AND UPPER(TRIM(existing.raw_description)) = UPPER(TRIM(?))
    )
  `;
  let totalRowsModified = 0;
  database.exec('BEGIN IMMEDIATE');

  try {
    const statement = database.prepare(sql);
    try {
      for (const tx of transactions) {
        const utrReference = tx.utrReference?.trim() || null;
        const params = [
          tx.id,
          tx.sourceType,
          tx.transactionDate,
          tx.transactionTime || null,
          tx.rawDescription,
          tx.cleanPartyName,
          tx.amount,
          tx.flowType,
          tx.category,
          tx.confidenceScore,
          tx.needsUserReview ? 1 : 0,
          tx.scope || 'self',
          tx.classificationReason,
          utrReference,
          utrReference,
          utrReference,
          utrReference,
          utrReference,
          tx.sourceType,
          tx.transactionDate,
          tx.transactionTime || null,
          tx.cleanPartyName,
          tx.amount,
          tx.flowType,
          tx.rawDescription,
        ];
        statement.bind(params);
        statement.step();
        totalRowsModified += database.changes();
        statement.reset();
      }
    } finally {
      statement.finalize();
    }

    database.exec('COMMIT');
    return totalRowsModified;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('[SQLite] Failed to roll back transaction import:', rollbackError);
    }
    throw error;
  }
}

function deduplicateTransactions(
  database: SQLiteDatabase,
  expectedDuplicateRows: number
): number {
  const rankedTransactions = `
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY
          CASE
            WHEN utr_reference IS NOT NULL AND TRIM(utr_reference) != ''
            THEN UPPER(TRIM(utr_reference))
            ELSE ''
          END,
          source_type,
          transaction_date,
          COALESCE(transaction_time, ''),
          UPPER(TRIM(clean_party_name)),
          amount,
          flow_type,
          UPPER(TRIM(raw_description))
        ORDER BY
          CASE WHEN scope = 'self' THEN 0 ELSE 1 END,
          CASE WHEN classification_reason = 'User manual override' THEN 0 ELSE 1 END,
          CASE WHEN requires_review = 0 THEN 0 ELSE 1 END,
          confidence_score DESC,
          id
      ) AS duplicate_rank
    FROM transactions
  `;

  database.exec('BEGIN IMMEDIATE');
  try {
    const duplicateCount = executeQuery(
      `SELECT COUNT(*) AS count FROM (${rankedTransactions}) WHERE duplicate_rank > 1`
    )[0]?.count ?? 0;
    if (duplicateCount !== expectedDuplicateRows) {
      throw new Error(
        `Duplicate count changed since the report (${expectedDuplicateRows} approved, ${duplicateCount} now). Refresh the report before retrying.`
      );
    }

    const rowsRemoved = executeStatement(`
      WITH ranked AS (${rankedTransactions})
      DELETE FROM transactions
      WHERE id IN (SELECT id FROM ranked WHERE duplicate_rank > 1)
    `);
    database.exec('COMMIT');
    return rowsRemoved;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('[SQLite] Failed to roll back duplicate cleanup:', rollbackError);
    }
    throw error;
  }
}

/**
 * Handle incoming messages from main thread
 */
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { id, type, sql, params = [] } = event.data;

  try {
    let data: any;

    if (type === 'RESET_CORRUPT_DATABASE') {
      await initPromise?.catch(() => undefined);
      if (db) {
        db.close();
        db = undefined;
      }
      initPromise = initializeDatabase(true);
      await initPromise;
      data = { rowsModified: 0 };
    } else {
      // Ensure DB is initialized before handling ordinary messages.
      await ensureDatabaseInitialized();
    }

    if (type === 'QUERY') {
      data = executeQuery(sql, params);
    } else if (type === 'EXEC') {
      const rowsModified = executeStatement(sql, params);
      data = { rowsModified };
    } else if (type === 'AUTO_CATEGORIZE_BATCH') {
      data = { rowsModified: autoCategorizeBatch(db, event.data.transactionIds || []) };
    } else if (type === 'INSERT_TRANSACTIONS') {
      data = { rowsModified: insertTransactionsBatch(db, event.data.transactions || []) };
    } else if (type === 'DEDUPLICATE_TRANSACTIONS') {
      data = {
        rowsModified: deduplicateTransactions(db, event.data.expectedDuplicateRows ?? -1),
      };
    } else if (type === 'APPLY_BATCH_REVIEWS') {
      applyBatchReviews(db, event.data.reviews || []);
      data = { rowsModified: 0 };
    } else if (type === 'CLEAR_ALL_DATA') {
      // Wipe transactions and merchant rules and reclaim space
      try {
        db.exec('BEGIN TRANSACTION');
        db.exec('DELETE FROM transactions');
        db.exec('DELETE FROM merchant_rules');
        db.exec('DELETE FROM payee_category_rules');
        const legacyRulesTable = executeQuery(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'merchant_rules_legacy'"
        );
        if (legacyRulesTable.length > 0) {
          db.exec('DELETE FROM merchant_rules_legacy');
        }
        seedDefaultMerchantRules(db);
        db.exec('COMMIT');
        // VACUUM to reclaim space
        try {
          db.exec('VACUUM');
        } catch (vacErr) {
          // ignore vacuum errors
        }
        data = { rowsModified: 0 };
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch(_) {}
        throw e;
      }
    }

    const response: WorkerResponse = {
      id,
      type: 'SUCCESS',
      data,
    };
    self.postMessage(response);
  } catch (error: any) {
    const response: WorkerResponse = {
      id,
      type: 'ERROR',
      error: error.message || String(error),
    };
    self.postMessage(response);
  }
};

/**
 * Initialize on worker startup
 */
ensureDatabaseInitialized().catch(error => {
  console.error('[SQLite Worker] Failed to initialize:', error);
  self.postMessage({
    type: 'ERROR',
    error: 'Failed to initialize SQLite',
  });
});
