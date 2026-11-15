import { useEffect, useState } from 'react';
import type { StandardCategory, TransactionScope } from '../types/finance';
import type { CategorySpend } from '../components/dashboard/CashflowSankey';
import { getMonthlyCategorySpending, type AnalyticsDatabase } from '../db/analyticsQueries';

interface CategorySpendingResult {
  month: string;
  scope: TransactionScope | 'all';
  data: CategorySpend[];
  error: string | null;
}

const CATEGORY_GROUPS: Array<{
  id: string;
  label: string;
  color: string;
  matches: StandardCategory[];
}> = [
  {
    id: 'rent-utilities',
    label: 'Rent & Flat Utilities',
    color: '#818cf8',
    matches: ['Utilities & Bills', 'Bills & Utilities'],
  },
  {
    id: 'groceries-dining',
    label: 'Groceries & Dining',
    color: '#4ade80',
    matches: [
      'Groceries & Supermarket',
      'Groceries',
      'Dining & Food Delivery',
      'Food & Dining',
      'Local Vendor / Chai & Snacks',
    ],
  },
  {
    id: 'medical',
    label: 'Medical',
    color: '#f87171',
    matches: ['Medical'],
  },
  {
    id: 'fuel-commute',
    label: 'Fuel & Commute',
    color: '#facc15',
    matches: ['Travel', 'Commute'],
  },
  {
    id: 'shopping',
    label: 'Shopping',
    color: '#fb7185',
    matches: [
      'Shopping & Retail',
      'Shopping',
      'Entertainment & Weekend Activities',
      'Digital Subscriptions & SaaS',
    ],
  },
  {
    id: 'daily-spend',
    label: 'Daily Spend',
    color: '#c084fc',
    matches: ['Small Daily Spends / Misc'],
  },
  {
    id: 'uncategorized',
    label: 'Other',
    color: '#94a3b8',
    matches: ['Uncategorized', 'Other'],
  },
];

export function getCategorySpendGroupId(category: string): string | undefined {
  return CATEGORY_GROUPS
    .find(group => group.matches.includes(category as StandardCategory))
    ?.id;
}

export function useCategorySpending(
  db: AnalyticsDatabase,
  selectedMonth: string,
  selectedScope: TransactionScope | 'all' = 'all',
  refreshToken?: object
): { data: CategorySpend[]; loading: boolean; error: string | null } {
  const [result, setResult] = useState<CategorySpendingResult | null>(null);
  const hasSelectionResult = result?.month === selectedMonth &&
    result.scope === selectedScope;
  const loading = !hasSelectionResult;

  useEffect(() => {
    let isCurrent = true;
    getMonthlyCategorySpending(db, selectedMonth, selectedScope)
      .then(rows => {
        if (!isCurrent) return;
        const totalsByGroup = new Map(CATEGORY_GROUPS.map(group => [group.id, 0]));
        for (const row of rows) {
          const groupId = getCategorySpendGroupId(row.category);
          if (groupId) {
            totalsByGroup.set(
              groupId,
              (totalsByGroup.get(groupId) || 0) + Number(row.netAmount || 0)
            );
          }
        }
        const data = CATEGORY_GROUPS
          .map(group => ({
            id: group.id,
            label: group.label,
            amount: totalsByGroup.get(group.id) || 0,
            color: group.color,
          }))
          .filter(category => category.amount > 0);
        setResult({ month: selectedMonth, scope: selectedScope, data, error: null });
      })
      .catch((error: unknown) => {
        if (!isCurrent) return;
        setResult({
          month: selectedMonth,
          scope: selectedScope,
          data: [],
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      isCurrent = false;
    };
  }, [db, selectedMonth, selectedScope, refreshToken]);

  return {
    data: hasSelectionResult ? result.data : [],
    loading,
    error: hasSelectionResult ? result.error : null,
  };
}
