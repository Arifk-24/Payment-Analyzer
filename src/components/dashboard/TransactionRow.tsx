import { useEffect, useState } from 'react';
import type { ParsedTransaction, StandardCategory, TransactionScope } from '../../types/finance';

const CATEGORIES: StandardCategory[] = [
  'Medical',
  'Groceries',
  'Food & Dining',
  'Shopping',
  'Bills & Utilities',
  'Commute',
  'Other',
  'Personal Transfer',
];

interface TransactionRowProps {
  transaction: ParsedTransaction;
  onCategoryChange: (
    id: string,
    category: StandardCategory,
    applyGlobally: boolean
  ) => Promise<void>;
  onScopeChange: (id: string, scope: TransactionScope) => Promise<void>;
}

function shouldApplyCategoryGlobally(transaction: ParsedTransaction): boolean {
  const payee = transaction.cleanPartyName.trim();
  return transaction.flowType === 'EXPENSE' &&
    transaction.category !== 'Personal Transfer' &&
    transaction.category !== 'Internal Transfer' &&
    payee !== '' &&
    payee.toUpperCase() !== 'UNKNOWN';
}

export function TransactionRow({
  transaction,
  onCategoryChange,
  onScopeChange,
}: TransactionRowProps) {
  const [error, setError] = useState<string | null>(null);
  const [applyGlobally, setApplyGlobally] = useState(
    () => shouldApplyCategoryGlobally(transaction)
  );
  const categoryOptions = CATEGORIES.includes(transaction.category)
    ? CATEGORIES
    : [transaction.category, ...CATEGORIES];

  useEffect(() => {
    setApplyGlobally(shouldApplyCategoryGlobally(transaction));
  }, [transaction.category, transaction.cleanPartyName, transaction.flowType]);

  const handleCategoryChange = async (category: StandardCategory) => {
    setError(null);
    try {
      await onCategoryChange(
        transaction.id,
        category,
        applyGlobally && category !== 'Personal Transfer'
      );
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    }
  };

  const handleScopeToggle = async () => {
    const nextScope: TransactionScope = transaction.scope === 'home' ? 'self' : 'home';
    setError(null);
    try {
      await onScopeChange(transaction.id, nextScope);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    }
  };

  return (
    <tr className="border-b border-gray-800 hover:bg-gray-800/60">
      <td className="whitespace-nowrap px-3 py-2 text-gray-300">
        {new Date(`${transaction.transactionDate}T00:00:00`).toLocaleDateString('en-IN')}
      </td>
      <td className="max-w-xs truncate px-3 py-2 text-gray-200">
        {transaction.cleanPartyName || transaction.rawDescription || 'Unknown payee'}
      </td>
      <td className={`whitespace-nowrap px-3 py-2 text-right font-mono ${
        transaction.flowType === 'INCOME' ? 'text-emerald-300' : 'text-gray-200'
      }`}>
        {transaction.flowType === 'INCOME' ? '+' : transaction.flowType === 'EXPENSE' ? '−' : ''}₹
        {transaction.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
      </td>
      <td className="px-3 py-2">
        <select
          aria-label={`Category for ${transaction.cleanPartyName}`}
          className="max-w-52 rounded-full border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-100 focus:border-blue-500 focus:outline-none"
          onChange={event => void handleCategoryChange(event.target.value as StandardCategory)}
          value={transaction.category}
        >
          {categoryOptions.map(category => (
            <option key={category} value={category}>{category}</option>
          ))}
        </select>
        <label className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-400">
          <input
            checked={applyGlobally}
            disabled={transaction.category === 'Personal Transfer'}
            onChange={event => setApplyGlobally(event.target.checked)}
            type="checkbox"
          />
          Apply to all transactions from this payee
        </label>
      </td>
      <td className="px-3 py-2">
        <button
          aria-label={`Change scope from ${transaction.scope === 'home' ? 'Home' : 'Self'}`}
          className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition ${
            transaction.scope === 'home'
              ? 'border-emerald-700 bg-emerald-950 text-emerald-200 hover:bg-emerald-900'
              : 'border-blue-700 bg-slate-800 text-blue-200 hover:bg-slate-700'
          }`}
          onClick={() => void handleScopeToggle()}
          type="button"
        >
          {transaction.scope === 'home' ? '🏠 Home' : '👤 Self'}
        </button>
        {error && <p className="mt-1 max-w-40 text-xs text-red-300">{error}</p>}
      </td>
      <td className="px-3 py-2 text-gray-300">{transaction.sourceType}</td>
      <td className="px-3 py-2 text-gray-300">{transaction.utrReference || '-'}</td>
    </tr>
  );
}
