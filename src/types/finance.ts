export type FlowType = 'EXPENSE' | 'INCOME' | 'INTERNAL_TRANSFER';
export type TransactionScope = 'self' | 'home';
export type StatementSource = 'PHONEPE' | 'GPAY' | 'CREDIT_CARD';

export type StandardCategory =
  | 'Medical'
  | 'Other'
  | 'Groceries & Supermarket'
  | 'Dining & Food Delivery'
  | 'Travel'
  | 'Local Vendor / Chai & Snacks'
  | 'Small Daily Spends / Misc'
  | 'Food & Dining'
  | 'Groceries'
  | 'Shopping'
  | 'Commute'
  | 'Bills & Utilities'
  | 'Entertainment & Weekend Activities'
  | 'Utilities & Bills'
  | 'Digital Subscriptions & SaaS'
  | 'Shopping & Retail'
  | 'Investments & Savings'
  | 'Internal Transfer'
  | 'Personal Transfer'
  | 'Salary & Income'
  | 'Uncategorized';

export interface TransferSettings {
  internalTransferAccountSuffixes: string[];
}

export interface ParsedTransaction {
  id: string;
  sourceType: StatementSource;
  transactionDate: string;        // YYYY-MM-DD
  transactionTime: string | null; // HH:mm:ss
  rawDescription: string;
  cleanPartyName: string;
  amount: number;
  flowType: FlowType;
  category: StandardCategory;
  confidenceScore: number;        // 0.0 to 1.0
  needsUserReview: boolean;
  classificationReason: string;
  scope: TransactionScope;
  utrReference?: string;
}

export interface MerchantRule {
  pattern: string;
  category: StandardCategory;
}