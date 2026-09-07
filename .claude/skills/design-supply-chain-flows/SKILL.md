---
name: design-supply-chain-flows
description: Design or improve supply-chain workflows, navigation, compact UI, contextual help, BI decisions, planning, quality, and alerts. Use when the central question is what users should understand or do next and how to verify that experience. Do not use for data ingestion, raw schema work, or release approval.
---

# Design Supply Chain Flows

Turn business intent into the smallest complete operating loop.

Use this as the only primary skill while the unresolved question is workflow behavior. Hand off
sequentially to `write-path` once implementation reaches an application-owned mutation, then to
`release-sweep` only after an exact candidate exists.

## Contract before screens

1. Identify actor, trigger, decision, source facts, state transition, exception path, owner, SLA, and evidence.
2. Define states and transitions explicitly; distinguish recommendation, approval, execution, and posting.
3. For planning, record horizon, grain, coverage, constraints, uncertainty, backtest baseline, and abstention conditions.
4. For quality, preserve batch genealogy, eligibility, hold/release authority, expiry, evidence, and recall reconstruction.
5. For alerts, require an accountable owner, actionable response, deduplication, suppression, severity, and false-positive budget.
6. Build the smallest vertical slice that closes a real user loop.

## UI rules

- For navigation, layout, help, search, or BI changes, read
  [experience-verification.md](references/experience-verification.md) before choosing the repair.
- Prefer server-rendered initial facts and small client islands.
- Use the shared list-state and toolbar components; wrap search-parameter clients in `Suspense`.
- Keep client modules free of value imports from `@/server/*` except the zero-import pure modules
  explicitly allowed by `tests/architecture/client-server-boundary.test.ts`; inspect that list rather
  than maintaining a second list here. Shared business-day formatting must use the existing authority.
- Make defaults useful, exceptions visible, empty states explanatory, and destructive actions explicit.
- Verify the workflow with observable scenarios, not page existence.
