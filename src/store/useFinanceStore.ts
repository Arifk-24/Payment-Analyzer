import { create } from 'zustand';
import {
  ParsedTransaction,
  MerchantRule,
  StandardCategory,
  TransferSettings,
  FlowType,
  TransactionScope,
} from '../types/finance';
import { getSqliteClient } from '../db/sqliteClient';
import {
  updateTransactionScope as persistTransactionScope,
} from '../db/analyticsQueries';

interface FinanceStore {
  // State
  transactions: ParsedTransaction[];
  rules: MerchantRule[];
  transferSettings: TransferSettings;
  isLoading: boolean;
  error: string | null;

  // Actions
  initDatabase: () => Promise<void>;
  addTransactions: (txs: ParsedTransaction[]) => Promise<number>;
  updateTransferSettings: (settings: Partial<TransferSettings>) => void;
  updateTransactionCategory: (
    id: string,
    newCategory: StandardCategory,
    applyGlobally?: boolean
  ) => Promise<void>;
  updateTransactionCategoryInline: (
    id: string,
    category: StandardCategory,
    applyGlobally?: boolean
  ) => Promise<void>;
  updateTransactionScope: (id: string, scope: TransactionScope) => Promise<void>;
  setError: (error: string | null) => void;
  clearTransactions: () => void;
  applyBatchReviews: (reviews: Array<{ id: string; partyName: string; category: StandardCategory; scope: TransactionScope }>) => Promise<void>;
  resetDatabase: () => Promise<void>;
}

const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  internalTransferAccountSuffixes: [],
};

export const useFinanceStore = create<FinanceStore>((set, get) => ({
  transactions: [],
  rules: [],
  transferSettings: DEFAULT_TRANSFER_SETTINGS,
  isLoading: false,
  error: null,

  /**
   * Initialize database: load transactions and rules from SQLite
   */
  initDatabase: async () => {
    set({ isLoading: true, error: null });
    try {
      const sqliteClient = getSqliteClient();

      const settings = await sqliteClient.getAllUserSettings();
      const storedSettings = settings.transfer_settings
        ? JSON.parse(settings.transfer_settings)
        : settings.commute_config
          ? JSON.parse(settings.commute_config)
          : null;
      const transferSettings = {
        internalTransferAccountSuffixes: Array.isArray(storedSettings?.internalTransferAccountSuffixes)
          ? storedSettings.internalTransferAccountSuffixes.filter(
              (suffix: unknown): suffix is string => typeof suffix === 'string'
            )
          : DEFAULT_TRANSFER_SETTINGS.internalTransferAccountSuffixes,
      };

      set({ transferSettings });

      // Load transactions
      const rawTxs = await sqliteClient.getTransactions();
      const transactions = rawTxs.map(tx => ({
        ...tx,
        transactionDate: normalizeDate(tx.transactionDate),
      }));
      set({ transactions });

      // Load merchant rules
      const rules = await sqliteClient.getAllRules();
      set({ rules });

      set({ isLoading: false });
    } catch (error: any) {
      const errorMsg = error.message || 'Failed to initialize database';
      set({ error: errorMsg, isLoading: false });
      console.error('[useFinanceStore] Database init failed:', error);
    }
  },

  /**
   * Add transactions: persist to SQLite and append to state
   */
  addTransactions: async (txs: ParsedTransaction[]) => {
    set({ isLoading: true, error: null });
    try {
      const sqliteClient = getSqliteClient();

      // Normalize dates before inserting
      const normalized = txs.map(t => ({ ...t, transactionDate: normalizeDate(t.transactionDate) }));

      // Insert into database
      const insertedCount = await sqliteClient.insertTransactions(normalized);
      await sqliteClient.autoCategorizeBatch(normalized.map(tx => tx.id));
      const storedTransactions = await sqliteClient.getTransactions();

      // Reload from SQLite so the dashboard and review queue reflect batch tagging.
      set({
        transactions: storedTransactions.map(tx => ({
          ...tx,
          transactionDate: normalizeDate(tx.transactionDate),
        })),
        isLoading: false,
      });
      return insertedCount;
    } catch (error: any) {
      const errorMsg = error.message || 'Failed to add transactions';
      set({ error: errorMsg, isLoading: false });
      console.error('[useFinanceStore] Add transactions failed:', error);
      throw error;
    }
  },

  /**
   * Update commute configuration
   */
  updateTransferSettings: (settings: Partial<TransferSettings>) => {
    set(state => {
      const nextSettings = {
        ...state.transferSettings,
        ...settings,
      };
      void getSqliteClient().saveUserSetting('transfer_settings', JSON.stringify(nextSettings));
      return { transferSettings: nextSettings };
    });
  },

  /**
   * Save ordinary categories as exact-payee rules; Personal Transfer stays per transaction.
   */
  updateTransactionCategory: async (
    id: string,
    newCategory: StandardCategory,
    applyGlobally = true
  ) => {
    set({ error: null });
    try {
      const sqliteClient = getSqliteClient();
      const state = get();
      const tx = state.transactions.find(transaction => transaction.id === id);
      if (!tx) return;
      await sqliteClient.applyBatchReviews([{
        id,
        partyName: tx.cleanPartyName,
        category: newCategory,
        scope: tx.scope,
        applyGlobally,
      }]);
      const payeeKey = tx.cleanPartyName.trim().toUpperCase();
      set(state => ({
        transactions: state.transactions.map(current => {
          const shouldUpdate = current.id === id ||
            (
              applyGlobally &&
              newCategory !== 'Personal Transfer' &&
              current.category !== 'Personal Transfer' &&
              payeeKey !== '' &&
              current.cleanPartyName.trim().toUpperCase() === payeeKey
            );
          if (!shouldUpdate) return current;
          return {
            ...current,
            category: newCategory,
            scope: applyGlobally ? tx.scope : current.scope,
            flowType: getFlowTypeForCategory(newCategory, current.rawDescription, current.flowType),
            needsUserReview: false,
            classificationReason: current.id === id
              ? 'User manual override'
              : 'Matched saved payee category',
            confidenceScore: 0.9,
          };
        }),
      }));
    } catch (error: any) {
      const errorMsg = error.message || 'Failed to update transaction category';
      set({ error: errorMsg });
      console.error('[useFinanceStore] Update category failed:', error);
      throw error;
    }
  },

  updateTransactionCategoryInline: async (id, category, applyGlobally) => {
    await get().updateTransactionCategory(id, category, applyGlobally);
  },

  updateTransactionScope: async (id, scope) => {
    const previous = get().transactions.find(tx => tx.id === id);
    if (!previous) return;
    set(state => ({
      error: null,
      transactions: state.transactions.map(tx => tx.id === id ? { ...tx, scope } : tx),
    }));

    try {
      await persistTransactionScope(getSqliteClient(), id, scope);
    } catch (error) {
      set(state => ({
        error: error instanceof Error ? error.message : String(error),
        transactions: state.transactions.map(tx => tx.id === id ? previous : tx),
      }));
      throw error;
    }
  },

  /**
   * Apply review decisions to the selected transactions and save scope per transaction.
   */
  applyBatchReviews: async (reviews: Array<{
    id: string;
    partyName: string;
    category: StandardCategory;
    scope: TransactionScope;
    applyGlobally?: boolean;
  }>) => {
    set({ error: null });
    try {
      const sqliteClient = getSqliteClient();
      await sqliteClient.applyBatchReviews(reviews);
      const reviewByTransaction = new Map(reviews.map(review => [review.id, review]));
      const categoryByPayee = new Map<
        string,
        { category: StandardCategory; scope: TransactionScope }
      >();
      for (const review of reviews) {
        if (
          review.category !== 'Personal Transfer' &&
          review.applyGlobally !== false &&
          review.partyName.trim()
        ) {
          categoryByPayee.set(review.partyName.trim().toUpperCase(), {
            category: review.category,
            scope: review.scope,
          });
        }
      }
      set(state => ({
        transactions: state.transactions.map(tx => {
          const review = reviewByTransaction.get(tx.id);
          const payeeRule = categoryByPayee.get(tx.cleanPartyName.trim().toUpperCase());
          const category = review?.category === 'Personal Transfer'
            ? 'Personal Transfer'
            : review?.category ?? (
              tx.category === 'Personal Transfer' ? undefined : payeeRule?.category
            );
          if (!category) return tx;
          return {
            ...tx,
            category,
            flowType: getFlowTypeForCategory(category, tx.rawDescription, tx.flowType),
            confidenceScore: 0.9,
            needsUserReview: false,
            classificationReason: review
              ? 'User manual override'
              : 'Matched saved payee category',
            scope: review?.scope ?? payeeRule?.scope ?? tx.scope,
          };
        }),
      }));
    } catch (error: any) {
      const errorMsg = error.message || 'Failed to apply batch reviews';
      set({ error: errorMsg });
      console.error('[useFinanceStore] applyBatchReviews failed:', error);
      throw error;
    }
  },

  /**
   * Set error message
   */
  setError: (error: string | null) => {
    set({ error });
  },

  /**
   * Clear all transactions from state (not database)
   */
  clearTransactions: () => {
    set({ transactions: [] });
  },

  /**
   * Reset / clear the entire database and local state
   */
  resetDatabase: async () => {
    set({ isLoading: true, error: null });
    try {
      const sqliteClient = getSqliteClient();
      await sqliteClient.resetCorruptDatabase();
      const rules = await sqliteClient.getAllRules();
      set({ transactions: [], rules, isLoading: false });
    } catch (error: any) {
      set({ error: error.message || 'Failed to reset database', isLoading: false });
    }
  },
}));

function getFlowTypeForCategory(
  category: StandardCategory,
  description: string,
  existingFlowType?: FlowType
): FlowType {
  if (category === 'Internal Transfer') return 'INTERNAL_TRANSFER';
  if (category === 'Salary & Income') return 'INCOME';
  if (category === 'Personal Transfer') return existingFlowType ?? 'EXPENSE';
  if (existingFlowType === 'INTERNAL_TRANSFER') {
    return /CREDIT|RECEIVED|CREDITED|INCOME|REFUND|REFUNDED|REVERSAL/i.test(description)
      ? 'INCOME'
      : 'EXPENSE';
  }
  return existingFlowType ?? 'EXPENSE';
}

/**
 * Normalize date strings into YYYY-MM-DD.
 * Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, and falls back to Date parsing.
 */
function normalizeDate(input: string): string {
  if (!input) return input;
  const s = input.trim();
  // already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD/MM/YYYY or DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  // Fallback: try Date parse
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) {
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  return s;
}
