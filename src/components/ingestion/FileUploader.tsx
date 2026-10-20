import { useState } from 'react';
import { UploadCloud, FileText, Lock, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { useFinanceStore } from '../../store/useFinanceStore';
import { extractTransactionsFromPDF } from '../../engine/pdf/pdfParser';

export function FileUploader() {
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [passwordPrompt, setPasswordPrompt] = useState<{
    fileName: string;
    file: File;
  } | null>(null);
  const [password, setPassword] = useState('');
  const [uploadStatus, setUploadStatus] = useState<{
    type: 'success' | 'error' | null;
    message: string;
    count?: number;
  }>({ type: null, message: '' });

  const { addTransactions, rules, setError } = useFinanceStore();

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(e.type === 'dragenter' || e.type === 'dragover');
  };

  const processFile = async (file: File, pwd?: string) => {
    try {
      setUploading(true);

      const result = await extractTransactionsFromPDF(file, pwd, rules);

      if (!result.success) {
        if (result.requiresPassword) {
          setPasswordPrompt({ fileName: file.name, file });
          setUploadStatus({ type: null, message: '' });
          return;
        }

        setUploadStatus({
          type: 'error',
          message: result.error || 'Failed to parse PDF',
        });
        setError(result.error || 'Failed to parse PDF');
        return;
      }

      if (result.transactions && result.transactions.length > 0) {
        const insertedCount = await addTransactions(result.transactions);
        const skippedCount = result.transactions.length - insertedCount;

        setUploadStatus({
          type: 'success',
          message: skippedCount > 0
            ? `Imported ${insertedCount} transactions from ${file.name}; skipped ${skippedCount} duplicates.`
            : `Successfully imported ${insertedCount} transactions from ${file.name}`,
          count: insertedCount,
        });

        // Clear message after 5 seconds
        setTimeout(() => {
          setUploadStatus({ type: null, message: '' });
        }, 5000);
      } else {
        setUploadStatus({
          type: 'error',
          message: 'No transactions found in the PDF',
        });
      }
    } catch (error: any) {
      setUploadStatus({
        type: 'error',
        message: error.message || 'Upload failed',
      });
      setError(error.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');

    if (files.length === 0) {
      setUploadStatus({
        type: 'error',
        message: 'Please drop PDF files only',
      });
      return;
    }

    // Process first file for now (could be extended for batch)
    processFile(files[0]);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files || []);
    if (files.length > 0) {
      processFile(files[0]);
    }
  };

  const handlePasswordSubmit = async () => {
    if (!passwordPrompt) return;

    await processFile(passwordPrompt.file, password);
    setPasswordPrompt(null);
    setPassword('');
  };

  return (
    <div className="space-y-6">
      {/* Password Prompt Modal */}
      {passwordPrompt && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2 text-yellow-500">
                <Lock size={24} />
                <h3 className="text-lg font-semibold">Password Protected</h3>
              </div>
              <button
                onClick={() => {
                  setPasswordPrompt(null);
                  setPassword('');
                }}
                className="text-gray-400 hover:text-gray-300"
              >
                <X size={20} />
              </button>
            </div>

            <p className="text-gray-300 text-sm mb-4">
              <strong>{passwordPrompt.fileName}</strong> is password protected. Please enter the password to continue.
            </p>

            <div className="bg-gray-800 rounded p-3 mb-4 text-xs text-gray-400">
              <p className="font-semibold mb-2">Common password formats:</p>
              <ul className="space-y-1 list-disc list-inside">
                <li>Date of Birth: DDMMYYYY (e.g., 15061990)</li>
                <li>PAN in CAPS (e.g., ABCDE1234F)</li>
                <li>Bank Account Last 4 Digits</li>
              </ul>
            </div>

            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handlePasswordSubmit()}
              placeholder="Enter password"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white placeholder-gray-500 mb-4 focus:outline-none focus:border-blue-500"
              autoFocus
            />

            <div className="flex gap-2">
              <button
                onClick={handlePasswordSubmit}
                disabled={!password.trim()}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded font-medium transition"
              >
                Unlock
              </button>
              <button
                onClick={() => {
                  setPasswordPrompt(null);
                  setPassword('');
                }}
                className="flex-1 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded font-medium transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload Zone */}
      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-12 text-center transition ${
          dragActive
            ? 'border-blue-500 bg-blue-950 bg-opacity-30'
            : 'border-gray-700 bg-gray-900 hover:border-gray-600'
        }`}
      >
        <UploadCloud
          size={48}
          className={`mx-auto mb-4 ${dragActive ? 'text-blue-500' : 'text-gray-500'}`}
        />
        <h3 className="text-lg font-semibold text-white mb-2">Upload Bank Statements</h3>
        <p className="text-gray-400 mb-4">
          Drag and drop PDF files here, or click to browse
        </p>

        <input
          type="file"
          multiple
          accept=".pdf"
          onChange={handleFileInput}
          disabled={uploading}
          className="hidden"
          id="file-upload"
        />
        <label
          htmlFor="file-upload"
          className="inline-block px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg cursor-pointer font-medium transition disabled:opacity-50"
        >
          Browse Files
        </label>

        <p className="text-xs text-gray-500 mt-4">Supported: PhonePe, Google Pay, Credit Card statements (PDF)</p>
      </div>

      {/* Upload Status */}
      {uploadStatus.type && (
        <div
          className={`flex items-start gap-3 p-4 rounded-lg border ${
            uploadStatus.type === 'success'
              ? 'bg-green-950 border-green-800 text-green-300'
              : 'bg-red-950 border-red-800 text-red-300'
          }`}
        >
          {uploadStatus.type === 'success' ? (
            <CheckCircle2 size={20} className="flex-shrink-0 mt-0.5" />
          ) : (
            <AlertCircle size={20} className="flex-shrink-0 mt-0.5" />
          )}
          <div>
            <p className="font-medium">{uploadStatus.message}</p>
            {uploadStatus.count && (
              <p className="text-sm opacity-90 mt-1">
                These transactions are now available in your dashboard for review.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Info Box */}
      <div className="bg-blue-950 border border-blue-800 rounded-lg p-4">
        <h4 className="font-semibold text-blue-300 mb-2">📋 Supported Formats</h4>
        <ul className="text-sm text-blue-200 space-y-1">
          <li>✓ PhonePe Transaction Statements</li>
          <li>✓ Google Pay UPI Statements</li>
          <li>✓ Credit Card Statements (HDFC, ICICI, SBI, etc.)</li>
        </ul>
      </div>
    </div>
  );
}
