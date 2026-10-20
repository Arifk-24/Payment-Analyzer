import { useEffect, useState } from 'react';
import { Settings, Shield } from 'lucide-react';
import { useFinanceStore } from './store/useFinanceStore';
import { TransferSettingsModal } from './components/settings/TransferSettingsModal';
import { FileUploader } from './components/ingestion/FileUploader';
import { UnmappedReviewTable } from './components/review/UnmappedReviewTable';
import { OverviewDashboard } from './components/dashboard/OverviewDashboard';

type Tab = 'overview' | 'upload' | 'review';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [reviewMonthFilter, setReviewMonthFilter] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { initDatabase, transactions, isLoading } = useFinanceStore();

  // Initialize database on mount
  useEffect(() => {
    initDatabase();
  }, []);

  const reviewCount = transactions.filter(tx => tx.needsUserReview).length;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center">
                <Shield size={24} className="text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">Payment Analyser</h1>
                <div className="flex items-center gap-2 mt-1">
                  <span className="inline-block px-2 py-0.5 bg-green-900 text-green-300 text-xs rounded-full">
                    ✓ 100% Local (Zero Egress)
                  </span>
                </div>
              </div>
            </div>

            <button
              onClick={() => setSettingsOpen(true)}
              className="p-2 hover:bg-gray-800 rounded-lg transition text-gray-400 hover:text-gray-300"
              title="Transfer Settings"
            >
              <Settings size={24} />
            </button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <nav className="border-b border-gray-800 bg-gray-900 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex gap-8">
            <button
              onClick={() => setActiveTab('overview')}
              className={`py-4 px-1 border-b-2 font-medium transition ${
                activeTab === 'overview'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              }`}
            >
              Overview & Charts
            </button>

            <button
              onClick={() => setActiveTab('upload')}
              className={`py-4 px-1 border-b-2 font-medium transition ${
                activeTab === 'upload'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              }`}
            >
              Ingestion & Upload
            </button>

            <button
              onClick={() => setActiveTab('review')}
              className={`py-4 px-1 border-b-2 font-medium transition flex items-center gap-2 ${
                activeTab === 'review'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              }`}
            >
              Review Queue
              {reviewCount > 0 && (
                <span className="ml-1 inline-block px-2 py-0.5 bg-yellow-900 text-yellow-300 text-xs rounded-full font-semibold">
                  {reviewCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="inline-block">
                <div className="animate-spin">
                  <Shield size={32} className="text-blue-500" />
                </div>
              </div>
              <p className="text-gray-400 mt-4">Loading your financial data...</p>
            </div>
          </div>
        )}

        {!isLoading && (
          <>
            {activeTab === 'overview' && (
              <OverviewDashboard
                onNavigateToReview={(month: string) => {
                  setReviewMonthFilter(month);
                  setActiveTab('review');
                }}
              />
            )}
            {activeTab === 'upload' && <FileUploader />}
            {activeTab === 'review' && (
              <UnmappedReviewTable
                reviewMonthFilter={reviewMonthFilter}
                setReviewMonthFilter={setReviewMonthFilter}
              />
            )}
          </>
        )}
      </main>

      {/* Settings Modal */}
      {settingsOpen && (
        <TransferSettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

export default App;
