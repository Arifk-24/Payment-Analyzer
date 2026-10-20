import { StandardCategory, MerchantRule, FlowType } from '../../types/finance';

function getFlowDirection(description: string, partyName: string): FlowType {
  const text = description.toUpperCase();
  const party = partyName.trim().toUpperCase();
  const paidToParty = party ? text.indexOf(`PAID TO ${party}`) : -1;
  const receivedFromParty = party ? text.indexOf(`RECEIVED FROM ${party}`) : -1;

  if (paidToParty >= 0 && (receivedFromParty < 0 || paidToParty < receivedFromParty)) return 'EXPENSE';
  if (receivedFromParty >= 0 && (paidToParty < 0 || receivedFromParty < paidToParty)) return 'INCOME';

  const receivedFrom = text.indexOf('RECEIVED FROM');
  const paidTo = text.indexOf('PAID TO');
  if (receivedFrom >= 0 && (paidTo < 0 || receivedFrom < paidTo)) return 'INCOME';
  if (paidTo >= 0 && (receivedFrom < 0 || paidTo < receivedFrom)) return 'EXPENSE';
  if (/\b(?:PAID\s+BY|DEBIT(?:ED)?|WITHDRAWN)\b/.test(text)) return 'EXPENSE';
  if (/\b(?:CREDIT(?:ED)?|RECEIVED|INCOME|REFUND(?:ED)?|REVERSAL)\b/.test(text)) return 'INCOME';
  if (/\bTRANSFER(?:\s+OUT)?\b/.test(text)) return 'EXPENSE';
  return 'EXPENSE';
}

/**
 * Main classification function for transactions
 */
type TransactionForClassification = {
  amount: number;
  cleanPartyName: string;
  rawDescription: string;
  transactionTime?: string | null;
};

export function classifyTransaction(
  transaction: TransactionForClassification,
  customRules?: MerchantRule[]
): {
  category: StandardCategory;
  flowType: FlowType;
  confidenceScore: number;
  needsUserReview: boolean;
  classificationReason: string;
} {
  const { amount, cleanPartyName, rawDescription } = transaction;

  // User-saved merchant rules take precedence over the default amount threshold.
  if (customRules) {
    for (const rule of customRules) {
      if (rule.category === 'Personal Transfer') continue;
      const pattern = rule.pattern.toUpperCase();
      if (cleanPartyName.toUpperCase().includes(pattern)) {
        const flowType = rule.category === 'Internal Transfer'
          ? 'INTERNAL_TRANSFER'
          : getFlowDirection(rawDescription, cleanPartyName);
        return {
          category: rule.category,
          flowType,
          confidenceScore: 0.9,
          needsUserReview: false,
          classificationReason: `Matched merchant rule: ${rule.pattern}`,
        };
      }
    }
  }

  // Keep the fallback category and threshold consistent with the SQLite batch tagger.
  if (amount <= 150) {
    return {
      category: 'Small Daily Spends / Misc',
      flowType: getFlowDirection(rawDescription, cleanPartyName),
      confidenceScore: 0.7,
      needsUserReview: false,
      classificationReason: 'Unmapped transaction of ₹150 or less',
    };
  }

  return {
    category: 'Uncategorized',
    flowType: getFlowDirection(rawDescription, cleanPartyName),
    confidenceScore: 0.3,
    needsUserReview: true,
    classificationReason: 'Unmapped transaction over ₹150, requires user review',
  };
}
