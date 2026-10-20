import { useState } from 'react';

export interface CategorySpend {
  id: string;
  label: string;
  amount: number;
  color: string;
}

interface CashflowSankeyProps {
  categories: CategorySpend[];
  onCategorySelect: (category: CategorySpend) => void;
  subtitle?: string;
}

interface RibbonLayout {
  category: CategorySpend;
  sourceTop: number;
  sourceBottom: number;
  targetTop: number;
  targetBottom: number;
}

const currencyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const VIEW_WIDTH = 800;
const VIEW_HEIGHT = 260;
const CHART_TOP = 18;
const CHART_BOTTOM = 242;
const CHART_HEIGHT = CHART_BOTTOM - CHART_TOP;
const NODE_WIDTH = 16;
const LEFT_NODE_X = 174;
const RIGHT_NODE_X = 590;
const RIBBON_START_X = LEFT_NODE_X + NODE_WIDTH;
const RIBBON_END_X = RIGHT_NODE_X;
const RIBBON_MID_X = (RIBBON_START_X + RIBBON_END_X) / 2;
const NODE_GAP = 10;

export function CashflowSankey({
  categories,
  onCategorySelect,
  subtitle = 'Total monthly outflow tracked',
}: CashflowSankeyProps) {
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const positiveCategories = categories.filter(category => category.amount > 0);
  const total = positiveCategories.reduce((sum, category) => sum + category.amount, 0);
  const formattedTotal = currencyFormatter.format(total);

  const gapSpace = Math.max(0, positiveCategories.length - 1) * NODE_GAP;
  const flowHeight = Math.max(0, CHART_HEIGHT - gapSpace);
  const ribbons: RibbonLayout[] = positiveCategories.map((category, index) => {
    const height = total > 0 ? (category.amount / total) * flowHeight : 0;
    const precedingHeight = positiveCategories
      .slice(0, index)
      .reduce((sum, previous) => sum + (previous.amount / total) * flowHeight, 0);
    const sourceTop = CHART_TOP + precedingHeight;
    const targetTop = CHART_TOP + precedingHeight + index * NODE_GAP;

    return {
      category,
      sourceTop,
      sourceBottom: sourceTop + height,
      targetTop,
      targetBottom: targetTop + height,
    };
  });

  const activeRibbon = ribbons.find(ribbon => ribbon.category.id === activeCategoryId);
  const leftBarHeight = ribbons.length > 0 ? flowHeight : 0;
  const leftBarMiddle = CHART_TOP + leftBarHeight / 2;

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <div className="mb-2 text-center">
        <p className="text-3xl font-bold tracking-tight text-white">
          {formattedTotal}
        </p>
        <p className="mt-1 text-sm text-gray-400">{subtitle}</p>
      </div>

      {positiveCategories.length === 0 ? (
        <div className="flex h-52 items-center justify-center text-sm text-gray-400">
          No categorized outflow for this month.
        </div>
      ) : (
        <>
          <div className="relative">
            {activeRibbon && (
              <div
                role="status"
                className="pointer-events-none absolute right-2 top-2 z-10 rounded-md border border-gray-700 bg-gray-950/95 px-3 py-2 text-right shadow-lg"
              >
                <p className="text-sm font-medium text-white">{activeRibbon.category.label}</p>
                <p className="font-mono text-sm text-gray-200">
                  {currencyFormatter.format(activeRibbon.category.amount)}
                  {' · '}
                  {((activeRibbon.category.amount / total) * 100).toFixed(1)}%
                </p>
              </div>
            )}
            <svg
              aria-label={`Monthly spending flow diagram totaling ${formattedTotal}`}
              className="block h-auto w-full overflow-visible"
              role="img"
              viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            >
              <text
                fill="#cbd5e1"
                fontSize="12"
                fontWeight="600"
                textAnchor="end"
                x={LEFT_NODE_X - 12}
                y={leftBarMiddle + 4}
              >
                Total Spending
              </text>

              {ribbons.map(ribbon => {
                const isActive = activeCategoryId === ribbon.category.id;
                const path = [
                  `M ${RIBBON_START_X} ${ribbon.sourceTop}`,
                  `C ${RIBBON_MID_X} ${ribbon.sourceTop}, ${RIBBON_MID_X} ${ribbon.targetTop}, ${RIBBON_END_X} ${ribbon.targetTop}`,
                  `L ${RIBBON_END_X} ${ribbon.targetBottom}`,
                  `C ${RIBBON_MID_X} ${ribbon.targetBottom}, ${RIBBON_MID_X} ${ribbon.sourceBottom}, ${RIBBON_START_X} ${ribbon.sourceBottom}`,
                  'Z',
                ].join(' ');

                return (
                  <path
                    key={ribbon.category.id}
                    d={path}
                    fill={ribbon.category.color}
                    fillOpacity={isActive ? 0.72 : 0.3}
                    onBlur={() => setActiveCategoryId(null)}
                    onFocus={() => setActiveCategoryId(ribbon.category.id)}
                    onMouseEnter={() => setActiveCategoryId(ribbon.category.id)}
                    onMouseLeave={() => setActiveCategoryId(null)}
                    onClick={() => onCategorySelect(ribbon.category)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onCategorySelect(ribbon.category);
                      }
                    }}
                    aria-label={`Show transactions for ${ribbon.category.label}`}
                    role="button"
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                  >
                    <title>
                      {ribbon.category.label}: {currencyFormatter.format(ribbon.category.amount)} (
                      {((ribbon.category.amount / total) * 100).toFixed(1)}%)
                    </title>
                  </path>
                );
              })}

              <rect
                fill="#93c5fd"
                height={leftBarHeight}
                rx={NODE_WIDTH / 2}
                width={NODE_WIDTH}
                x={LEFT_NODE_X}
                y={CHART_TOP}
              />

              {ribbons.map(ribbon => (
                <g
                  key={ribbon.category.id}
                  aria-label={`Show transactions for ${ribbon.category.label}`}
                  onClick={() => onCategorySelect(ribbon.category)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onCategorySelect(ribbon.category);
                    }
                  }}
                  role="button"
                  style={{ cursor: 'pointer' }}
                  tabIndex={0}
                >
                  <rect
                    fill={ribbon.category.color}
                    height={ribbon.targetBottom - ribbon.targetTop}
                    rx={NODE_WIDTH / 2}
                    width={NODE_WIDTH}
                    x={RIGHT_NODE_X}
                    y={ribbon.targetTop}
                  />
                  <text
                    dominantBaseline="middle"
                    fill="#e2e8f0"
                    fontSize="12"
                    x={RIGHT_NODE_X + NODE_WIDTH + 12}
                    y={(ribbon.targetTop + ribbon.targetBottom) / 2}
                  >
                    {ribbon.category.label}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
            <span className="text-blue-200">Total Spending</span>
            <span>Categories</span>
          </div>
        </>
      )}
    </section>
  );
}
