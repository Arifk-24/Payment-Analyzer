import { useState } from 'react';
import { X } from 'lucide-react';
import { useFinanceStore } from '../../store/useFinanceStore';
import { TransferSettings } from '../../types/finance';
import { DuplicateReport, getSqliteClient } from '../../db/sqliteClient';

interface TransferSettingsModalProps {
  onClose: () => void;
}

export function TransferSettingsModal({ onClose }: TransferSettingsModalProps) {
  const { transferSettings, updateTransferSettings, resetDatabase, initDatabase } = useFinanceStore();

  const [settings, setSettings] = useState<TransferSettings>(transferSettings);
  const [duplicateReport, setDuplicateReport] = useState<DuplicateReport | null>(null);
  const [isLoadingReport, setIsLoadingReport] = useState(false);
  const [isCleaningDuplicates, setIsCleaningDuplicates] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);

  const refreshDuplicateReport = async () => {
    setDuplicateReport(await getSqliteClient().getDuplicateReport());
  };

  const removeDuplicateRows = async () => {
    if (!duplicateReport) return;
    const expectedDuplicateRows = duplicateReport.summary.reduce(
      (total, summary) => total + summary.removableRows,
      0
    );
    if (expectedDuplicateRows === 0) return;

    setIsCleaningDuplicates(true);
    setReportError(null);
    setCleanupResult(null);
    try {
      const rowsRemoved = await getSqliteClient().deduplicateTransactions(expectedDuplicateRows);
      await initDatabase();
      const storeError = useFinanceStore.getState().error;
      if (storeError) throw new Error(`Duplicates were removed, but the transaction list could not be refreshed: ${storeError}`);
      await refreshDuplicateReport();
      setCleanupResult(`Removed ${rowsRemoved} duplicate transaction${rowsRemoved === 1 ? '' : 's'}.`);
    } catch (error) {
      setReportError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCleaningDuplicates(false);
    }
  };

  const handleSave = () => {
    updateTransferSettings(settings);
    onClose();
  };

  const normalizeAccountSuffixes = (input: string) =>
    input
      .split(',')
      .map(value => value.replace(/[^0-9]/g, '').trim())
      .filter(Boolean)
      .slice(0, 20);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 max-w-3xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white">Transfer Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-300 transition"
          >
            <X size={24} />
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto pr-1">
          <div className="space-y-3">
            <h3 className="font-semibold text-gray-300">Your Own Accounts</h3>
            <div className="space-y-2">
              <label className="block text-sm text-gray-400">
                Account suffixes (comma-separated)
              </label>
              <input
                type="text"
                value={settings.internalTransferAccountSuffixes.join(', ')}
                onChange={e =>
                  setSettings({
                    ...settings,
                    internalTransferAccountSuffixes: normalizeAccountSuffixes(e.target.value),
                  })
                }
                placeholder="1234, 5678"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
              />
              <p className="text-xs text-gray-500">
                A transaction mentioning one of these account suffixes in a transfer context will be excluded from expenses.
              </p>
            </div>
          </div>

          <section className="space-y-3 border-t border-gray-800 pt-5">
            <div>
              <h3 className="font-semibold text-gray-300">Duplicate transaction report</h3>
              <p className="mt-1 text-xs text-gray-500">
                Scanning is read-only. Deletion runs only when you select the cleanup button below.
              </p>
            </div>
            <button
              type="button"
              disabled={isLoadingReport}
              onClick={async () => {
                setIsLoadingReport(true);
                setReportError(null);
                setCleanupResult(null);
                try {
                  await refreshDuplicateReport();
                } catch (error) {
                  setReportError(error instanceof Error ? error.message : String(error));
                } finally {
                  setIsLoadingReport(false);
                }
              }}
              className="rounded bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-wait disabled:opacity-60"
            >
              {isLoadingReport ? 'Scanning…' : duplicateReport ? 'Refresh report' : 'Scan duplicates'}
            </button>

            {reportError && (
              <p role="alert" className="rounded border border-red-800 bg-red-950 p-2 text-sm text-red-200">
                Duplicate operation failed: {reportError}
              </p>
            )}

            {duplicateReport && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(['UTR event', 'Fingerprint'] as const).map(kind => {
                    const summary = duplicateReport.summary.find(item => item.kind === kind);
                    return (
                      <div key={kind} className="rounded border border-gray-800 bg-gray-950 p-3 text-sm">
                        <p className="font-medium text-gray-200">{kind === 'UTR event' ? 'Matching UTR and transaction details' : 'No-UTR fingerprint'}</p>
                        <p className="mt-1 text-gray-400">
                          {summary?.duplicateGroups ?? 0} groups · {summary?.rowsInGroups ?? 0} transactions ·{' '}
                          {summary?.removableRows ?? 0} extra rows if retaining one per group
                        </p>
                        <p className="mt-1 text-gray-500">
                          Category conflicts: {summary?.categoryConflictGroups ?? 0} · Scope conflicts: {summary?.scopeConflictGroups ?? 0}
                        </p>
                        <p className="mt-1 text-gray-500">
                          Payee: {summary?.payeeConflictGroups ?? 0} · Amount: {summary?.amountConflictGroups ?? 0} · Date: {summary?.dateConflictGroups ?? 0}
                        </p>
                        <p className="text-gray-500">
                          Source: {summary?.sourceConflictGroups ?? 0} · Description: {summary?.descriptionConflictGroups ?? 0}
                        </p>
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-amber-200">
                  Duplicate groups match exact transaction events. Cleanup keeps Self when a group has conflicting scopes.
                </p>
                {cleanupResult && (
                  <p role="status" className="rounded border border-green-800 bg-green-950 p-2 text-sm text-green-200">
                    {cleanupResult}
                  </p>
                )}
                {duplicateReport.summary.some(summary => summary.removableRows > 0) && (
                  <button
                    type="button"
                    disabled={isCleaningDuplicates || isLoadingReport}
                    onClick={() => void removeDuplicateRows()}
                    className="rounded bg-red-800 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-wait disabled:opacity-60"
                  >
                    {isCleaningDuplicates
                      ? 'Removing duplicates…'
                      : `Delete ${duplicateReport.summary.reduce((total, summary) => total + summary.removableRows, 0).toLocaleString()} extra rows`}
                  </button>
                )}
                {duplicateReport.groups.length > 0 && (
                  <div className="max-h-64 overflow-auto rounded border border-gray-800">
                    <table className="w-full text-left text-xs">
                      <thead className="sticky top-0 bg-gray-800 text-gray-300">
                        <tr>
                          <th className="px-2 py-2">Match</th>
                          <th className="px-2 py-2">Key</th>
                          <th className="px-2 py-2">Rows</th>
                          <th className="px-2 py-2">Categories</th>
                          <th className="px-2 py-2">Scopes</th>
                          <th className="px-2 py-2">Payees</th>
                          <th className="px-2 py-2">Dates / amounts</th>
                          <th className="px-2 py-2">Description samples</th>
                          <th className="px-2 py-2">Differing fields</th>
                        </tr>
                      </thead>
                      <tbody>
                        {duplicateReport.groups.map((group, index) => (
                          <tr key={`${group.kind}-${group.groupKey}-${index}`} className="border-t border-gray-800 text-gray-300">
                            <td className="whitespace-nowrap px-2 py-2">{group.kind}</td>
                            <td className="max-w-56 break-all px-2 py-2">{group.groupKey}</td>
                            <td className="px-2 py-2">{group.transactionCount}</td>
                            <td className="max-w-40 break-words px-2 py-2">{group.categories}</td>
                            <td className="px-2 py-2">{group.scopes}</td>
                            <td className="max-w-40 break-words px-2 py-2">{group.payees}</td>
                            <td className="max-w-40 break-words px-2 py-2">
                              {group.dates} · ₹{group.amounts}
                            </td>
                            <td className="max-w-64 break-words px-2 py-2">{group.descriptionSamples}</td>
                            <td className="max-w-48 break-words px-2 py-2">
                              {[
                                group.categoryVariantCount > 1 && 'category',
                                group.scopeVariantCount > 1 && 'scope',
                                group.payeeVariantCount > 1 && 'payee',
                                group.amountVariantCount > 1 && 'amount',
                                group.dateVariantCount > 1 && 'date',
                                group.sourceVariantCount > 1 && 'source',
                                group.descriptionVariantCount > 1 && 'description',
                              ].filter(Boolean).join(', ') || 'none'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="border-t border-gray-800 px-2 py-2 text-gray-500">
                      Showing up to 25 largest duplicate groups.
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {/* Actions */}
        <div className="flex gap-2 mt-6 pt-6 border-t border-gray-800">
          <button
            onClick={handleSave}
            className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium transition"
          >
            Save
          </button>
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded font-medium transition"
          >
            Cancel
          </button>
          <button
            onClick={async () => {
              const ok = window.confirm('Are you sure you want to delete all stored transactions and rules? This cannot be undone.');
              if (!ok) return;
              try {
                await resetDatabase();
                alert('All data cleared.');
                onClose();
              } catch (err: any) {
                alert('Failed to clear data: ' + (err?.message || String(err)));
              }
            }}
            className="px-4 py-2 bg-red-700 hover:bg-red-600 text-white rounded font-medium transition"
          >
            Reset All Data
          </button>
        </div>
      </div>
    </div>
  );
}
