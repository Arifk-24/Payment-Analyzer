# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

You can also install [eslint-plugin-react-x](https://npmx.dev/package/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://npmx.dev/package/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

## Transaction categorization

Imported transactions are classified in SQLite in this order: an exact saved
payee category, a configured merchant rule, a configured keyword found in the
payee or statement description, then the amount-based fallback. The fallback
assigns transactions up to ₹150 to Small Daily Spends / Misc; unmatched larger
transactions remain Uncategorized for review.

Description keyword rules are stored in `description_category_rules` and use
case-insensitive SQLite string matching (`INSTR`), not regular expressions.
The initial utility keywords (rent, Wi-Fi, broadband, electricity, water/gas
bills, and utility/bill payments) map to Bills & Utilities. When a transaction
is assigned an ordinary category, the cleaned payee/category pair is saved and
applied to other transactions for that payee, including future imports.
Personal Transfer is the exception: it is saved only on the selected
transaction and does not create or propagate a payee rule. Existing Personal
Transfer rows are not overwritten when a regular payee rule is applied. When
the global payee option is enabled, the selected category and scope (Self/Home)
are saved together and applied to that payee's other non-Personal-Transfer
transactions. With the global option disabled, both changes remain limited to
the selected transaction.

If an imported utility transaction has no usable payee, its description is
used to infer a utility payee (Electricity, Wi-Fi / Broadband, Gas, Water, or
Maintenance) before the saved merchant and keyword rules run. Description
keyword rules also provide fallback categories for medical services, bills,
groceries, food, and commute spending.

Sankey chart groups are derived from the saved transaction category; the chart
does not infer a category from payee or description text.

Monthly category spending is calculated from debits minus qualifying refund,
reversal, and reimbursement credits assigned to the same category, month, and
scope. A credit explicitly categorized by the user as an expense-category
refund/reimbursement also offsets that category for that transaction only.
Incoming Personal Transfer credits reduce only the overall monthly
total; Personal Transfer debits and internal transfers are neutral to
spending. Other incoming credits, including salary, do not offset spending.
Uncategorized debits count as spending and appear in the Other Sankey group;
their credits offset that group only when identified as refunds or
reimbursements. Credits are never matched by payee or applied to other
transactions. Merchant and source summaries remain debit-only.

Imports deduplicate on a non-empty UTR (case/whitespace-insensitive) plus
matching source, date/time, cleaned payee, amount, flow, and description. When
no UTR is present, the same transaction details form the fingerprint. Existing
rows are preserved; existing repeated UTRs are reported rather than
automatically deleted.
