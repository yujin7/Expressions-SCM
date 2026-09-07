# Supply-chain experience: task to evidence

Use for navigation, compact layout, contextual help, search, or BI work. This is not an
additional primary skill, a new design system, or authority to change business rules.

## Inspect the experience that is actually running

Identify route, role, viewport/zoom, revision, filter state, data cutoff, and reproduction steps.
Distinguish a screenshot of an older deployment from a defect in the candidate. Read the shared
component and at least two affected consumers before applying an across-the-board change.
Avoid global CSS fixes based only on one screenshot or assuming a healthy API proves hydration.

Define the useful loop in the user's words: entry → find relevant facts → understand exception
→ choose an allowed action → see the outcome → return with context. Record clicks, scroll,
failures and elapsed time before claiming fewer steps or faster work; do not optimize page count.

## Reuse the product's existing contracts

| Need | Inspect before adding another abstraction |
|---|---|
| Menus and page discovery | `src/lib/route-access.ts`, `AppShell`, `CommandPalette`, `GlobalSearch` |
| Filters, sorting, saved views | `useListState`, `ListToolbar`, actual API pagination/sort contract |
| Metrics, units, explanations | `metrics`, `DecisionMetric`, `CaliberNote`, `DataSourceBadge` |
| Charts and drill-down | Existing chart shells and report callers; carry current filters/role |
| Loading/retry/empty states | Existing load-error components and the relevant request lifecycle |

Keep bookmarked URLs and authorized deep links when combining screens. A page can be searchable
without occupying a permanent menu slot. Test query-tab selection and back/forward navigation.
Client visibility must not replace server authorization or channel-scope checks.

## Compact without concealing meaning

- Group by the decision and workflow stage, not by implementation module. Put frequent actions
  near their facts; consolidate secondary table utilities in the existing view menu.
- Size KPI grids from available space; avoid both one-card-per-screen stacks and seven unreadable
  squeezed cards. Preserve units, source state and the action, not decorative whitespace.
- Keep horizontal scrolling inside genuinely wide tables. Verify long Chinese names, identifiers,
  negative/large amounts, nested tables, small windows and browser zoom; do not merely clip overflow.
- Keep warnings needed to act safely visible. Put extended formulas/examples in a labelled native
  button/popover reachable by keyboard and touch. Hover alone is insufficient for essential help.
- Each visual must answer a named decision with grain, units, time, denominator, coverage and a
  useful drill-down. Reuse metric definitions; do not add a chart or semantic layer just to fill space.
  Zero, missing, stale, not authorized and not applicable remain distinct, including color semantics.

## Test the interactions most likely to lie

For the changed path, choose relevant cases rather than checking every item on every task:

1. Search: page and entity results coexist; duplicate labels select the right identity; clearing,
   closing, switching query and unmounting invalidate old results and navigation targets.
   Out-of-order success/failure cannot replace current results. Loading, no match and failure differ.
2. Lists: filter/sort resets the appropriate pagination, server-side lists sort the full population,
   shared links restore context, and sibling tabs do not erase one another's parameters.
3. BI: missing denominators never become healthy-looking zero; detail and summary reconcile at
   the same cutoff; a drill-down preserves the relevant filter and cannot expose masked fields.
4. Help/navigation: Tab, Enter, Escape, focus return and a pointer/touch path work. Test the actual
   UI library; a callback harness does not prove focus, popup clipping, hydration or layout.
5. Workflow: perform one representative allowed action in synthetic data, inspect the resulting
   state/feedback and return path. Test refusal/retry without duplicate effects where applicable.

Use focused component/rule tests for feedback, then an isolated real-browser flow at representative
desktop and narrow widths. Capture errors and inspect screenshots. Report the viewport, role and
cases actually checked; do not extrapolate one page to all pages. Final candidate readiness still
belongs to `release-sweep`; development evidence is not deployment or UAT approval.

## Research only where it changes a decision

Reviewed 2026-09-07: [W3C combobox keyboard pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/),
[Carbon table usage](https://carbondesignsystem.com/components/data-table/usage/),
[Ant Design Tooltip](https://ant.design/components/tooltip/).
These guide interaction choices, not a mandate to install Carbon or upgrade AntD. Check the installed
major version's types and behavior before using current online examples.
