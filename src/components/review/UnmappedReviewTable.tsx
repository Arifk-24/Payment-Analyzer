import { useState, useMemo } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useFinanceStore } from '../../store/useFinanceStore';
import { StandardCategory } from '../../types/finance';

const STANDARD_CATEGORIES: StandardCategory[] = [
  'Medical',
  'Local Vendor / Chai & Snacks',
  'Small Daily Spends / Misc',
  'Food & Dining',
  'Groceries',
  'Shopping',
  'Commute',
  'Bills & Utilities',
  'Entertainment & Weekend Activities',
  'Digital Subscriptions & SaaS',
  'Investments & Savings',
  'Other',
  'Internal Transfer',
  'Personal Transfer',
  'Salary & Income',
  'Uncategorized',
];

export function UnmappedReviewTable({ reviewMonthFilter, setReviewMonthFilter }: { reviewMonthFilter?: string | null; setReviewMonthFilter?: (m: string | null) => void }) {
  const { transactions, applyBatchReviews, updateTransactionScope } = useFinanceStore();
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [stagedChanges, setStagedChanges] = useState<Record<string, {
    category: StandardCategory;
    partyName: string;
    applyGlobally: boolean;
  }>>({});
  const [applyGloballyByTransaction, setApplyGloballyByTransaction] = useState<
    Record<string, boolean>
  >({});
  const [localSelectedMonth, setLocalSelectedMonth] = useState<string | null>(reviewMonthFilter || null);
  const selectedMonth = setReviewMonthFilter
    ? reviewMonthFilter ?? null
    : localSelectedMonth;

  const changeSelectedMonth = (month: string | null) => {
    setLocalSelectedMonth(month);
    setReviewMonthFilter?.(month);
  };

  const availableMonths = useMemo(() => {
    const months = new Set(transactions.map(tx => tx.transactionDate.slice(0, 7)));
    return Array.from(months).sort().reverse();
  }, [transactions]);

  // Filter transactions that need review and optionally by month
  const reviewItems = transactions.filter(tx => {
    if (!tx.needsUserReview) return false;
    if (selectedMonth) return tx.transactionDate.startsWith(selectedMonth);
    return true;
  });

  const handleCategoryChange = (
    txId: string,
    newCategory: StandardCategory,
    partyName: string
  ) => {
    const applyGlobally = newCategory === 'Personal Transfer'
      ? false
      : applyGloballyByTransaction[txId] ?? true;
    setStagedChanges(prev => ({
      ...prev,
      [txId]: { category: newCategory, partyName, applyGlobally },
    }));
    setOpenDropdown(null);
  };

  const handleApplyGloballyChange = (txId: string, applyGlobally: boolean) => {
    setApplyGloballyByTransaction(prev => ({ ...prev, [txId]: applyGlobally }));
    setStagedChanges(prev => prev[txId]
      ? { ...prev, [txId]: { ...prev[txId], applyGlobally } }
      : prev);
  };

  const handleApplyStaged = async () => {
    const reviews = Object.entries(stagedChanges).map(([id, {
      category,
      partyName,
      applyGlobally,
    }]) => ({
      id,
      partyName,
      category,
      scope: transactions.find(tx => tx.id === id)?.scope ?? 'self',
      applyGlobally: category === 'Personal Transfer' ? false : applyGlobally,
    }));

    if (reviews.length === 0) return;

    try {
      await applyBatchReviews(reviews);
      setStagedChanges({});
      setApplyGloballyByTransaction({});
    } catch (err) {
      console.error('[UnmappedReviewTable] applyBatchReviews failed', err);
      alert('Failed to apply reviews: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleScopeChange = async (id: string, scope: 'self' | 'home') => {
    try {
      await updateTransactionScope(id, scope);
    } catch (err) {
      alert(`Failed to update transaction scope: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">
            Review Queue ({reviewItems.length})
          </h2>
          <p className="text-sm text-gray-400">Transactions that need manual categorization</p>
        </div>

        <div className="flex items-center gap-3">
          {selectedMonth ? (
            <div className="text-sm text-gray-300">
              Showing reviews for:{' '}
              <strong>
                {(() => {
                  const [y, m] = selectedMonth.split('-');
                  const d = new Date(parseInt(y), parseInt(m) - 1);
                  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'long' });
                })()}
              </strong>
            </div>
          ) : (
            <div className="text-sm text-gray-300">Showing reviews for: <strong>All months</strong></div>
          )}

          <select
            value={selectedMonth || ''}
            onChange={e => {
              const val = e.target.value || null;
              changeSelectedMonth(val);
            }}
            className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white"
          >
            <option value="">All months</option>
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

          {selectedMonth && (
            <button
              onClick={() => {
                changeSelectedMonth(null);
              }}
              className="px-2 py-1 bg-gray-700 text-sm rounded text-gray-200"
            >
              Show All
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={handleApplyStaged}
          disabled={Object.keys(stagedChanges).length === 0}
          className={`px-3 py-2 rounded text-sm font-semibold ${Object.keys(stagedChanges).length === 0 ? 'bg-gray-700 text-gray-400' : 'bg-green-600 hover:bg-green-500 text-white'}`}
        >
          Apply & Save Reviewed ({Object.keys(stagedChanges).length})
        </button>
      </div>

      {reviewItems.length === 0 && (
        <div className="text-center py-8">
          <div className="text-5xl mb-3">🎉</div>
          <h3 className="text-lg font-semibold text-white mb-1">All Caught Up!</h3>
          <p className="text-gray-400">No transactions pending review for the selected period.</p>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto bg-gray-900 border border-gray-800 rounded-lg">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-800">
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-300">
                Date
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-300">
                Recipient
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-300">
                Amount
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-300">
                Source
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-300">
                Reason
              </th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-gray-300">
                Scope
              </th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-gray-300">
                Category
              </th>
            </tr>
          </thead>
          <tbody>
            {reviewItems.map(tx => (
              <tr key={tx.id} className="border-b border-gray-800 hover:bg-gray-800 transition">
                <td className="px-4 py-3 text-sm text-gray-300">
                  {new Date(tx.transactionDate).toLocaleDateString('en-IN')}
                </td>
                <td className="px-4 py-3 text-sm text-gray-300 max-w-xs truncate">
                  {tx.cleanPartyName}
                </td>
                <td className="px-4 py-3 text-sm text-right text-gray-300 font-mono">
                  ₹{tx.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-3 text-sm">
                  <span className="px-2 py-1 bg-gray-800 text-gray-300 rounded text-xs">
                    {tx.sourceType}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-gray-400 max-w-xs">
                  <span className="line-clamp-2">{tx.classificationReason}</span>
                </td>
                <td className="px-4 py-3 text-center">
                  <select
                    aria-label={`Scope for ${tx.cleanPartyName}`}
                    value={tx.scope}
                    onChange={event => void handleScopeChange(tx.id, event.target.value as 'self' | 'home')}
                    className={`px-2 py-1 border rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                      tx.scope === 'home'
                        ? 'bg-emerald-950 border-emerald-800 text-emerald-200'
                        : 'bg-slate-800 border-slate-700 text-slate-200'
                    }`}
                  >
                    <option value="self">👤 Self</option>
                    <option value="home">🏠 Home</option>
                  </select>
                </td>
                {/* Category Dropdown */}
                <td className="px-4 py-3">
                  <div className="relative">
                    <button
                      onClick={() =>
                        setOpenDropdown(openDropdown === tx.id ? null : tx.id)
                      }
                      className="w-full flex items-center justify-between px-2 py-1 bg-gray-800 border border-gray-700 rounded text-gray-300 text-sm hover:border-gray-600 transition"
                    >
                      <span className="truncate">
                        {stagedChanges[tx.id]?.category
                          ? stagedChanges[tx.id].category
                          : tx.category === 'Uncategorized'
                          ? 'Select...'
                          : tx.category}
                      </span>
                      <ChevronDown size={16} className="flex-shrink-0 ml-2" />
                    </button>

                    {openDropdown === tx.id && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded shadow-lg z-10 max-h-60 overflow-y-auto">
                        {STANDARD_CATEGORIES.map(cat => (
                          <button
                            key={cat}
                            onClick={() =>
                              handleCategoryChange(tx.id, cat, tx.cleanPartyName)
                            }
                            className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition flex items-center justify-between"
                          >
                            <span>{cat}</span>
                            { (stagedChanges[tx.id]?.category === cat || tx.category === cat) && (
                              <Check size={16} className="text-green-500" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <label className="mt-2 flex items-center gap-1.5 text-[11px] text-gray-400">
                    <input
                      checked={stagedChanges[tx.id]?.category === 'Personal Transfer'
                        ? false
                        : applyGloballyByTransaction[tx.id] ?? true}
                      disabled={stagedChanges[tx.id]?.category === 'Personal Transfer'}
                      onChange={event => handleApplyGloballyChange(tx.id, event.target.checked)}
                      type="checkbox"
                    />
                    Apply to all transactions from this payee
                  </label>

                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Info */}
      <div className="bg-blue-950 border border-blue-800 rounded p-3 text-xs text-blue-200">
        <strong>Tip:</strong> The global-payee option is on by default. Uncheck it before saving to change only this transaction. Personal Transfer always remains transaction-specific. Scope stays per transaction.
      </div>
    </div>
  );
}
