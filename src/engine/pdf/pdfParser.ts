import * as pdfjsLib from 'pdfjs-dist';
import {
  ParsedTransaction,
  StatementSource,
} from '../../types/finance';
import { detectStatementFormat } from '../parsers/formatDetector';
import { parsePhonePeStatement } from '../parsers/phonepeParser';
import { parseGPayStatement } from '../parsers/gpayParser';
import { parseCreditCardStatement } from '../parsers/creditCardParser';
import { classifyTransaction } from '../heuristics/classifier';
import type { MerchantRule } from '../../types/finance';

// Set up the worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

export interface PDFExtractionResult {
  success: boolean;
  requiresPassword?: boolean;
  transactions?: ParsedTransaction[];
  error?: string;
  sourceType?: StatementSource;
}

/**
 * Extract transactions from a PDF file
 * Supports password-protected PDFs, detects format, and parses transactions
 */
export async function extractTransactionsFromPDF(
  file: File,
  password?: string,
  customRules?: MerchantRule[]
): Promise<PDFExtractionResult> {
  try {
    const arrayBuffer = await file.arrayBuffer();

    // Load PDF document (use any to avoid strict pdfjs type mismatches)
    let pdfDoc: any;
    try {
      pdfDoc = await pdfjsLib.getDocument({
        data: arrayBuffer,
        password: password || '',
      }).promise;
    } catch (error: any) {
      // Check if it's a password-required error
      if (
        error.name === 'PasswordException' ||
        error.message?.includes('password') ||
        error.message?.includes('encrypted')
      ) {
        return {
          success: false,
          requiresPassword: true,
          error: 'PDF is password-protected',
        };
      }
      throw error;
    }

    // Extract text from all pages
    let fullText = '';
    const pageCount = pdfDoc.numPages;

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent: any = await page.getTextContent();

      // Build text with layout awareness
      const pageText = buildTextFromContent(textContent);
      fullText += pageText + '\n---PAGE BREAK---\n';
    }

    // Detect statement format
    const sourceType = detectStatementFormat(fullText);

    if (sourceType === 'UNKNOWN') {
      return {
        success: false,
        error: 'Unable to detect statement format. Please ensure the PDF is a valid bank/payment statement.',
      };
    }

    // Parse transactions based on format
    let rawTransactions = [];

    switch (sourceType) {
      case 'PHONEPE':
        rawTransactions = parsePhonePeStatement(fullText);
        break;
      case 'GPAY':
        rawTransactions = parseGPayStatement(fullText);
        break;
      case 'CREDIT_CARD':
        rawTransactions = parseCreditCardStatement(fullText);
        break;
      default:
        return {
          success: false,
          error: `Unsupported statement format: ${sourceType}`,
        };
    }

    if (rawTransactions.length === 0) {
      return {
        success: false,
        error: 'No transactions found in the PDF. The statement format may not be fully supported.',
      };
    }

    // Classify transactions
    const transactions: ParsedTransaction[] = [];
    let txId = 1;

    for (const rawTx of rawTransactions) {
      try {
        // Generate unique ID
        const id = `${sourceType}-${Date.now()}-${txId++}`;

        // Classify the transaction
        const classification = classifyTransaction(
          {
            amount: rawTx.amount,
            cleanPartyName: rawTx.payee,
            rawDescription: rawTx.description,
            transactionTime: rawTx.time ?? null,
          },
          customRules
        );

        const parsedTx: ParsedTransaction = {
          id,
          sourceType: sourceType as StatementSource,
          transactionDate: rawTx.date,
          transactionTime: rawTx.time || null,
          rawDescription: rawTx.description,
          cleanPartyName: rawTx.payee,
          amount: rawTx.amount,
          flowType: classification.flowType || (classification.category === 'Internal Transfer' ? 'INTERNAL_TRANSFER' : 'EXPENSE'),
          category: classification.category,
          confidenceScore: classification.confidenceScore,
          needsUserReview: classification.needsUserReview,
          classificationReason: classification.classificationReason,
          scope: 'self',
          utrReference: rawTx.utc,
        };

        transactions.push(parsedTx);
      } catch (error) {
        console.warn('[PDF Parser] Failed to classify transaction:', rawTx, error);
        // Skip this transaction rather than failing the whole batch
      }
    }

    return {
      success: true,
      transactions,
      sourceType,
    };
  } catch (error: any) {
    console.error('[PDF Parser] Extraction failed:', error);
    return {
      success: false,
      error: error.message || 'Failed to extract transactions from PDF',
    };
  }
}

/**
 * Build text content from PDF text items, preserving layout
 */
function buildTextFromContent(textContent: any): string {
  let currentY = 0;
  let line = '';
  const lines: string[] = [];

  for (const item of textContent.items) {
    const textItem: any = item;

    // Check if we're on a new line (Y position changed significantly)
    if (Math.abs((textItem.y || 0) - currentY) > 5 && line.trim()) {
      lines.push(line.trim());
      line = '';
    }

    currentY = textItem.y || currentY;
    line += (textItem.str || '') + ' ';
  }

  if (line.trim()) {
    lines.push(line.trim());
  }

  return lines.join('\n');
}
