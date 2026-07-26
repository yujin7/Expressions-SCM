---
name: design-supply-chain-flows
description: Design or implement an end-to-end supply-chain workflow, page, planning recommendation, quality control, alert, PRD, state machine, domain contract, or acceptance criteria. Use when the central question is what users should decide and how the workflow should behave. Do not use for data ingestion, raw schema work, or release approval.
---

# Design Supply Chain Flows

Turn business intent into the smallest complete operating loop.

## Contract before screens

1. Identify actor, trigger, decision, source facts, state transition, exception path, owner, SLA, and evidence.
2. Define states and transitions explicitly; distinguish recommendation, approval, execution, and posting.
3. For planning, record horizon, grain, coverage, constraints, uncertainty, backtest baseline, and abstention conditions.
4. For quality, preserve batch genealogy, eligibility, hold/release authority, expiry, evidence, and recall reconstruction.
5. For alerts, require an accountable owner, actionable response, deduplication, suppression, severity, and false-positive budget.
6. Build the smallest vertical slice that closes a real user loop.

## UI rules

- Prefer server-rendered initial facts and small client islands.
- Use the shared list-state and toolbar components; wrap search-parameter clients in `Suspense`.
- Keep client modules free of value imports from `@/server/*`.
- Make defaults useful, exceptions visible, empty states explanatory, and destructive actions explicit.
- Verify the workflow with observable scenarios, not page existence.

Consult `docs/skill-history/` only for a relevant deep playbook such as planning, cosmetics quality, alerts, or list pages.
