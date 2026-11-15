import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { TrendingUp, TrendingDown, Clock } from 'lucide-react';
import { useFinanceStore } from '../../store/useFinanceStore';
import { ParsedTransaction, StandardCategory, TransactionScope } from '../../types/finance';
import { getSqliteClient } from '../../db/sqliteClient';
import { CashflowSankey } from './CashflowSankey';
import { TransactionRow } from './TransactionRow';
import { getCategorySpendGroupId, useCategorySpending } from '../../hooks/useCategorySpending';
import {
  BurnSplit,
  getSpendByMerchant,
  getBurnSplit,
  getTopOutflows,
  MerchantSpend,
  OutflowTransaction,
} from '../../db/analyticsQueries';
import {
  getSpendingImpact,
  isSpendingCredit,
  isSpendingCategory,
  isSpendingOffset,
} from '../../utils/spending';

function isInternalTransfer(tx: ParsedTransaction): boolean {
  return tx.flowType === 'INTERNAL_TRANSFER' || tx.category === 'Internal Transfer';
}

// Define category colors for consistent charts
const CATEGORY_COLORS: Record<StandardCategory, string> = {
  'Groceries & Supermarket': '#10b981',
  'Medical': '#f87171',
  'Other': '#9ca3af',
  'Dining & Food Delivery': '#f59e0b',
  'Travel': '#3b82f6',
  'Local Vendor / Chai & Snacks': '#ec4899',
  'Small Daily Spends / Misc': '#a855f7',
  'Food & Dining': '#f59e0b',
  'Groceries': '#10b981',
  'Shopping': '#06b6d4',
  'Commute': '#3b82f6',
  'Bills & Utilities': '#6366f1',
  'Entertainment & Weekend Activities': '#f97316',
  'Utilities & Bills': '#6366f1',
  'Digital Subscriptions & SaaS': '#8b5cf6',
  'Shopping & Retail': '#06b6d4',
  'Investments & Savings': '#14b8a6',
  'Internal Transfer': '#6b7280',
  'Personal Transfer': '#a78bfa',
  'Salary & Income': '#22c55e',
  'Uncategorized': '#9ca3af',
};

const SOURCE_COLORS: Record<string, string> = {
  PHONEPE: '#6f3c96',
  GPAY: '#3b82f6',
  CREDIT_CARD: '#ef4444',
};

export function OverviewDashboard({ onNavigateToReview }: { onNavigateToReview?: (month: string) => void }) {
  const {
    transactions,
    updateTransactionCategoryInline,
    updateTransactionScope,
  } = useFinanceStore();
  const [selectedMonth, setSelectedMonth] = useState<string>(
    new Date().toISOString().slice(0, 7) // YYYY-MM
  );
  const [selectedScope, setSelectedScope] = useState<TransactionScope | 'all'>('all');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);
  const availableMonths = useMemo(() => {
    const months = new Set(transactions.map(tx => tx.transactionDate.slice(0, 7)));
    return Array.from(months).sort().reverse();
  }, [transactions]);
  const displayedMonth = availableMonths.includes(selectedMonth)
    ? selectedMonth
    : availableMonths[0] || selectedMonth;
  const categorySpending = useCategorySpending(
    getSqliteClient(),
    displayedMonth,
    selectedScope,
    transactions
  );

  useEffect(() => {
    if (selectedCategory) {
      ledgerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedCategory]);
  const [analyticsResult, setAnalyticsResult] = useState<{
    month: string;
    scope: TransactionScope | 'all';
    outflows: OutflowTransaction[];
    merchants: MerchantSpend[];
    burnSplit: BurnSplit;
    error?: string;
  } | null>(null);
  const hasAnalyticsForSelection = analyticsResult?.month === displayedMonth &&
    analyticsResult.scope === selectedScope;
  const analyticsLoading = !hasAnalyticsForSelection;
  const analyticsError = analyticsResult?.month === displayedMonth &&
    analyticsResult.scope === selectedScope
    ? analyticsResult.error
    : null;
  const topOutflows = hasAnalyticsForSelection
    ? analyticsResult.outflows
    : [];
  const topMerchants = hasAnalyticsForSelection
    ? analyticsResult.merchants
    : [];
  const burnSplit = hasAnalyticsForSelection
    ? analyticsResult.burnSplit
    : null;

  useEffect(() => {
    let isCurrent = true;

    const db = getSqliteClient();
    Promise.all([
      getTopOutflows(db, displayedMonth, 5, selectedScope),
      getSpendByMerchant(db, displayedMonth, 5, selectedScope),
      getBurnSplit(db, displayedMonth, selectedScope),
    ])
      .then(([outflows, merchants, split]) => {
        if (!isCurrent) return;
        setAnalyticsResult({
          month: displayedMonth,
          scope: selectedScope,
          outflows,
          merchants,
          burnSplit: split,
        });
      })
      .catch((error: unknown) => {
        if (!isCurrent) return;
        const message = error instanceof Error ? error.message : String(error);
        setAnalyticsResult({
          month: displayedMonth,
          scope: selectedScope,
          outflows: [],
          merchants: [],
          burnSplit: { fixed: 0, discretionary: 0 },
          error: message,
        });
      });

    return () => {
      isCurrent = false;
    };
  }, [displayedMonth, selectedScope, transactions]);

  // Filter transactions by selected month
  const filteredTransactions = useMemo(() => {
    return transactions.filter(tx =>
      tx.transactionDate.startsWith(displayedMonth) &&
      (selectedScope === 'all' || tx.scope === selectedScope)
    );
  }, [transactions, displayedMonth, selectedScope]);

  // Calculate metrics
  const metrics = useMemo(() => {
    const reviewItems = filteredTransactions.filter(tx => tx.needsUserReview);

    const totalSpends = categorySpending.data.reduce((sum, category) => sum + category.amount, 0);

    const totalInternalTransfers = filteredTransactions
      .filter(isInternalTransfer)
      .reduce((sum, tx) => sum + tx.amount, 0);

    const personalTransferTransactions = filteredTransactions.filter(
      tx => tx.category === 'Personal Transfer'
    );

    const investmentTransactions = filteredTransactions.filter(
      tx => tx.category === 'Investments & Savings' && tx.flowType === 'EXPENSE'
    );

    const expenseCount = filteredTransactions.filter(tx =>
      tx.flowType === 'EXPENSE' && isSpendingCategory(tx.category)
    ).length;
    const spendAdjustments = filteredTransactions
      .filter(isSpendingOffset)
      .reduce((sum, tx) => sum + tx.amount, 0);

    return {
      totalSpends,
      totalInternalTransfers,
      totalPersonalTransfers: personalTransferTransactions.reduce((sum, tx) => sum + tx.amount, 0),
      personalTransferCount: personalTransferTransactions.length,
      totalInvestments: investmentTransactions.reduce((sum, tx) => sum + tx.amount, 0),
      investmentCount: investmentTransactions.length,
      spendAdjustments,
      reviewCount: reviewItems.length,
      expenseCount,
    };
  }, [categorySpending.data, filteredTransactions]);

  // Source breakdown data
  const sourceBreakdown = useMemo(() => {
    const breakdown: Record<string, number> = {};

    for (const tx of filteredTransactions) {
      if (isInternalTransfer(tx) || tx.flowType !== 'EXPENSE' || !isSpendingCategory(tx.category)) continue;
      breakdown[tx.sourceType] = (breakdown[tx.sourceType] || 0) + tx.amount;
    }

    return Object.entries(breakdown).filter(([, amount]) => amount > 0).map(([source, amount]) => ({
      name: source,
      amount,
    }));
  }, [filteredTransactions]);

  const formatCurrency = (value: number) => {
    return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  };

  return (
    <div className="space-y-6">
      {/* Month Selector */}
      <div className="flex flex-wrap items-center gap-4">
        <label htmlFor="dashboard-month" className="text-sm font-medium text-gray-300">
          Select Month:
        </label>
        <select
          id="dashboard-month"
          value={displayedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-blue-500"
        >
          {availableMonths.map(month => {
            const [year, monthNum] = month.split('-');
            const date = new Date(parseInt(year), parseInt(monthNum) - 1);
            const label = date.toLocaleDateString('en-IN', { year: 'numeric', month: 'long' });
            return (
              <option key={month} value={month}>
                {label}
              </option>
            );
          })}
        </select>
        <label htmlFor="dashboard-scope" className="text-sm font-medium text-gray-300">
          Scope:
        </label>
        <select
          id="dashboard-scope"
          value={selectedScope}
          onChange={event => setSelectedScope(event.target.value as TransactionScope | 'all')}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="all">All Spends</option>
          <option value="self">👤 Self</option>
          <option value="home">🏠 Home</option>
        </select>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Total Spends (clickable) */}
        <button
          onClick={() => setSelectedCategory('ALL_SPENDS')}
          className="bg-gradient-to-br from-red-900 to-red-800 border border-red-700 rounded-lg p-6 text-left cursor-pointer hover:border-red-500/50 hover:bg-red-500/10 transition-all"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-red-200 text-sm font-medium">Net Monthly Spending</p>
              <p className="text-3xl font-bold text-white mt-2">
                {formatCurrency(metrics.totalSpends)}
              </p>
              <p className="text-xs text-red-300 mt-2">{metrics.expenseCount} transactions</p>
              <p className="text-xs text-red-300 mt-1">
                Credits offset: −{formatCurrency(metrics.spendAdjustments)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-100 opacity-90">View all →</span>
              <TrendingDown size={40} className="text-red-400 opacity-50" />
            </div>
          </div>
        </button>

        {/* Internal Transfers (clickable) */}
        <button
          onClick={() => setSelectedCategory('Internal Transfer')}
          className="bg-gradient-to-br from-gray-800 to-gray-700 border border-gray-600 rounded-lg p-6 text-left hover:border-amber-400/30 hover:bg-amber-400/5 transition"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-gray-300 text-sm font-medium">Internal Transfers Neutralized</p>
              <p className="text-3xl font-bold text-white mt-2">
                {formatCurrency(metrics.totalInternalTransfers)}
              </p>
              <p className="text-xs text-gray-400 mt-2">Not counted in spends</p>
            </div>
            <TrendingUp size={40} className="text-gray-500 opacity-50" />
          </div>
        </button>

        {/* Personal Transfers (clickable) */}
        <button
          onClick={() => setSelectedCategory('Personal Transfer')}
          className="bg-gradient-to-br from-violet-900 to-violet-800 border border-violet-700 rounded-lg p-6 text-left cursor-pointer hover:border-violet-500/50 hover:bg-violet-500/10 transition-all"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-violet-200 text-sm font-medium">Personal Transfers</p>
              <p className="text-3xl font-bold text-white mt-2">
                {formatCurrency(metrics.totalPersonalTransfers)}
              </p>
              <p className="text-xs text-violet-300 mt-2">
                {metrics.personalTransferCount} transactions
              </p>
              <p className="text-xs text-violet-300 mt-1">Excluded from monthly spend</p>
            </div>
            <TrendingUp size={40} className="text-violet-400 opacity-50" />
          </div>
        </button>

        {/* Investments & Savings (clickable) */}
        <button
          onClick={() => setSelectedCategory('Investments & Savings')}
          className="bg-gradient-to-br from-teal-900 to-teal-800 border border-teal-700 rounded-lg p-6 text-left cursor-pointer hover:border-teal-500/50 hover:bg-teal-500/10 transition-all"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-teal-200 text-sm font-medium">Investments &amp; Savings</p>
              <p className="text-3xl font-bold text-white mt-2">
                {formatCurrency(metrics.totalInvestments)}
              </p>
              <p className="text-xs text-teal-300 mt-2">{metrics.investmentCount} transactions</p>
              <p className="text-xs text-teal-300 mt-1">Excluded from monthly spend</p>
            </div>
            <TrendingUp size={40} className="text-teal-400 opacity-50" />
          </div>
        </button>

        {/* Review Items (clickable) */}
        <button
          onClick={() => onNavigateToReview && onNavigateToReview(displayedMonth)}
          className="bg-gradient-to-br from-yellow-900 to-yellow-800 border border-yellow-700 rounded-lg p-6 cursor-pointer hover:border-amber-500/50 hover:bg-amber-500/10 transition-all text-left"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-yellow-200 text-sm font-medium">Pending Review</p>
              <p className="text-3xl font-bold text-white mt-2">{metrics.reviewCount}</p>
              <p className="text-xs text-yellow-300 mt-2">Ambiguous transactions</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-sm text-yellow-200 opacity-90">Click to review →</div>
              <Clock size={40} className="text-yellow-400 opacity-50" />
            </div>
          </div>
        </button>
      </div>

      {analyticsError && (
        <div className="rounded-lg border border-red-800 bg-red-950 p-3 text-sm text-red-200">
          Could not load monthly outflow analytics: {analyticsError}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Top 5 Outflow Spends</h3>
          {analyticsLoading ? (
            <p className="text-sm text-gray-400">Loading outflows…</p>
          ) : topOutflows.length === 0 ? (
            <p className="text-sm text-gray-400">No qualifying outflows for this month.</p>
          ) : (
            <ul className="divide-y divide-gray-800">
              {topOutflows.map(tx => (
                <li key={tx.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-100">
                      {tx.cleanPartyName || tx.rawDescription || 'Unknown payee'}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-gray-400">
                        {new Date(`${tx.transactionDate}T00:00:00`).toLocaleDateString('en-IN')}
                      </span>
                      <span
                        className="rounded-full px-2 py-0.5 text-xs text-gray-200"
                        style={{ backgroundColor: CATEGORY_COLORS[tx.category as StandardCategory] || '#4b5563' }}
                      >
                        {tx.category || 'Uncategorized'}
                      </span>
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-sm font-semibold text-red-300">
                    {formatCurrency(tx.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Top 5 Merchants · Debit Spend</h3>
          {analyticsLoading ? (
            <p className="text-sm text-gray-400">Loading merchants…</p>
          ) : topMerchants.length === 0 ? (
            <p className="text-sm text-gray-400">No merchant spend for this month.</p>
          ) : (
            <ul className="space-y-4">
              {topMerchants.map(merchant => {
                const maxSpend = topMerchants[0]?.totalSpent || 1;
                const barWidth = Math.max(4, (merchant.totalSpent / maxSpend) * 100);
                return (
                  <li key={merchant.merchant}>
                    <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                      <span className="truncate text-gray-200">{merchant.merchant}</span>
                      <span className="shrink-0 font-mono text-gray-300">
                        {formatCurrency(merchant.totalSpent)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-gray-800">
                      <div
                        className="h-full rounded-full bg-blue-500"
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                    <p className="mt-1 text-right text-xs text-gray-500">
                      {merchant.transactionCount} {merchant.transactionCount === 1 ? 'transaction' : 'transactions'}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="rounded-lg border border-gray-800 bg-gray-900 p-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-white">Monthly Burn Split</h3>
            <p className="mt-1 text-sm text-gray-400">
              Fixed (rent and utilities) vs discretionary spending ·{' '}
              {selectedScope === 'all' ? 'All scopes' : selectedScope === 'home' ? 'Home' : 'Self'}
            </p>
          </div>
          <p className="text-xs text-gray-500">
            Net of qualifying refunds in the matching category
          </p>
        </div>
        {analyticsLoading ? (
          <p className="text-sm text-gray-400">Loading burn split…</p>
        ) : analyticsError ? (
          <p className="text-sm text-red-300">Could not load burn split: {analyticsError}</p>
        ) : burnSplit ? (
          <div className="space-y-4">
            {([
              { label: 'Fixed', amount: Number(burnSplit.fixed), color: 'bg-indigo-400' },
              {
                label: 'Discretionary',
                amount: Number(burnSplit.discretionary),
                color: 'bg-emerald-400',
              },
            ]).map(item => {
              const total = Math.max(0, Number(burnSplit.fixed)) +
                Math.max(0, Number(burnSplit.discretionary));
              const width = total > 0
                ? Math.min(100, Math.max(0, (Math.max(0, item.amount) / total) * 100))
                : 0;
              return (
                <div key={item.label}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                    <span className="text-gray-200">{item.label}</span>
                    <span className="font-mono text-gray-100">{formatCurrency(item.amount)}</span>
                  </div>
                  <div
                    aria-label={`${item.label} spending`}
                    className="h-2 overflow-hidden rounded-full bg-gray-800"
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={width}
                  >
                    <div className={`h-full ${item.color}`} style={{ width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          {categorySpending.error && (
            <div className="mb-3 rounded-lg border border-red-800 bg-red-950 p-3 text-sm text-red-200">
              Could not load category spending: {categorySpending.error}
            </div>
          )}
          {categorySpending.loading ? (
            <section className="flex h-80 items-center justify-center rounded-lg border border-gray-800 bg-gray-900 text-sm text-gray-400">
              Loading category spending…
            </section>
          ) : (
            <CashflowSankey
              categories={categorySpending.data}
              onCategorySelect={category => setSelectedCategory(category.id)}
              subtitle={`Net categorized spend · ${
                selectedScope === 'all' ? 'All scopes' : selectedScope === 'home' ? 'Home' : 'Self'
              }`}
            />
          )}
        </div>

        {/* Spend by Source */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Spend by Source · Debit Spend</h3>
          {sourceBreakdown.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={sourceBreakdown}>
                <CartesianGrid strokeDasharray="3 3" stroke="#4b5563" />
                <XAxis dataKey="name" stroke="#9ca3af" />
                <YAxis stroke="#9ca3af" />
                <Tooltip
                  formatter={value => formatCurrency(value as number)}
                  contentStyle={{
                    backgroundColor: '#111827',
                    border: '1px solid #374151',
                    borderRadius: '6px',
                  }}
                  labelStyle={{ color: '#d1d5db' }}
                />
                <Bar dataKey="amount" fill="#3b82f6" radius={[8, 8, 0, 0]}>
                  {sourceBreakdown.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={SOURCE_COLORS[entry.name] || '#3b82f6'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-60 flex items-center justify-center text-gray-400">
              No transaction data for this period
            </div>
          )}
        </div>
      </div>

      {/* Drill-down ledger for selected category */}
      {selectedCategory && (
        <div ref={ledgerRef} className="scroll-mt-4 bg-gray-900 border border-gray-800 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">
              {selectedCategory === 'ALL_SPENDS'
                ? 'Ledger: All Spends'
                : `Ledger: ${categorySpending.data.find(category => category.id === selectedCategory)?.label || selectedCategory}`}
            </h3>
            <button
              onClick={() => setSelectedCategory(null)}
              className="text-sm text-gray-300 bg-gray-800 px-3 py-1 rounded"
            >
              Close
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 border-b border-gray-800">
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Payee</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-left">Category</th>
                  <th className="px-3 py-2 text-left">Scope</th>
                  <th className="px-3 py-2 text-left">Source</th>
                  <th className="px-3 py-2 text-left">UTR</th>
                </tr>
              </thead>
              <tbody>
                {filteredTransactions
                  .filter(tx => {
                    if (selectedCategory === 'ALL_SPENDS') {
                      return getSpendingImpact(tx) !== 0;
                    }
                    if (selectedCategory === 'Internal Transfer') {
                      return isInternalTransfer(tx);
                    }
                    if (selectedCategory === 'Personal Transfer') return tx.category === selectedCategory;
                    if (selectedCategory === 'Investments & Savings') {
                      return tx.category === selectedCategory;
                    }
                    if (categorySpending.data.some(category => category.id === selectedCategory)) {
                      return (
                        (tx.flowType === 'EXPENSE' ||
                          (tx.flowType === 'INCOME' && isSpendingCredit(tx))) &&
                        isSpendingCategory(tx.category) &&
                        getCategorySpendGroupId(tx.category) === selectedCategory
                      );
                    }
                    return (tx.flowType === 'EXPENSE' ||
                      (tx.flowType === 'INCOME' && isSpendingCredit(tx))) &&
                      isSpendingCategory(tx.category) &&
                      tx.category === selectedCategory;
                  })
                  .sort((a, b) => new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime())
                  .map(transaction => (
                    <TransactionRow
                      key={transaction.id}
                      transaction={transaction}
                      onCategoryChange={updateTransactionCategoryInline}
                      onScopeChange={updateTransactionScope}
                    />
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
