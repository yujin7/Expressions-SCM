# Project map and source-of-truth discipline

## Contents

1. Project signature
2. Authority and reading order
3. Task-to-document router
4. Current business and technical shape
5. Project terminology
6. Durable implementation invariants
7. Known evidence traps
8. Change and verification discipline

## 1. Project signature

Treat a workspace directory as this project when it contains:

- `spec/CURRENT.md`
- `spec/01-系统完整规格-v2.0.md`
- `spec/14-系统进化总PRD.md`
- `supply-chain/package.json`
- `supply-chain/src/server/posting/`

When starting inside the `supply-chain` repository, the equivalent signature is `package.json`,
`src/server/posting/`, `CLAUDE.md`, and `../spec/CURRENT.md`. Resolve the repository with
`git rev-parse --show-toplevel`; search only provided workspace roots if the project moved. Never
hard-code a personal path or recursively search a broad home/filesystem root.

## 2. Authority and reading order

Match authority to the question instead of applying one universal precedence:

1. **Current approved intent:** current user decision, `spec/CURRENT.md`, and the current
   specifications it names, including explicit amendments.
2. **Repository operating contract:** `supply-chain/CLAUDE.md` / `AGENTS.md`.
3. **Implemented behavior:** schema, migrations, services, rules, routes, jobs, UI, configuration,
   and the exact revision.
4. **Verified behavior:** reproducible tests, UAT, queries, logs, API/UI observations, and
   reconciliation artifacts.
5. **Deployed behavior:** deployed revision, environment configuration, telemetry, operational
   reconciliation, and sign-off evidence.
6. **History and rationale:** audit archives (`03`, `05`, `06`), original inputs, meeting notes,
   and git history.

Resolve conflicts explicitly:

- Quote or point to both competing statements.
- Identify which source claims authority and whether the implementation agrees.
- Classify the mismatch as stale documentation, incomplete implementation, or unresolved decision.
- Never select a convenient answer silently.

Do not trust embedded commit IDs, test counts, data volumes, or “complete” labels without current verification.

## 3. Task-to-document router

| Task | Read first | Then inspect |
|---|---|---|
| Current status or next priority | `CURRENT.md`, `14` | git status/log, relevant code and tests |
| MVP scope or acceptance | `CURRENT.md`, `02`, `07` | affected routes/services/tests |
| Core entities, state machines, permissions | `01`, explicit amendments in `04` | `src/db/schema`, `docflow`, DTOs, APIs |
| Data import, master data, snapshots, lineage | `04`, `13` | adapters, staging/release engine, refs, migrations, import tests |
| Product requirements and omitted intent | original PRD, `00`, `08` | current decision register and implementation |
| Supplier lifecycle | `10`, `09`, `CURRENT.md` | supplier schema/service/UI, scorecard, alerts |
| Automatic outsourced-production chain | `11`, `14`, `CURRENT.md` | auto-chain, kitting/ATP rules, approval and posting boundaries |
| SPU/SKU policy | `12`, `04`, `CURRENT.md` | masters schema, aliases, release/regroup logic |
| Platform evolution/AI/planning | `14`, `13` | rules, projections, reports, jobs, data coverage |
| Audit history or rationale | `03`, `05`, `06`, `08` | current files to test whether finding remains true |

Read a referenced section in context. A heading hit alone is not sufficient when a later paragraph amends it.

## 4. Current business and technical shape

Verify these live before relying on them:

- Business: multi-brand cosmetics/consumer-goods company, hundreds of finished-product SKUs, large component/raw-material catalog, outsourced/OEM production, Excel and external-system data sources, rapid growth, omnichannel inventory blind spots.
- Core flow: `BH → WO → PO + JG → FL/TL → SH + QC → RK → JS`, with CT purchase returns, stock documents, counts, reversals, reconciliation, and external references.
- Architecture: Next.js App Router + TypeScript + React + Ant Design; PostgreSQL/PGlite + Drizzle; NextAuth; pg-boss; Vitest/PGlite.
- Shape: modular monolith with server modules, pure rules, a central posting engine, a unified approval/state layer, imports through staging/release, and reports/decision support.
- Data states: transactional ledger for controlled warehouses, external snapshots/reference facts for other coverage, derived planning views, and review queues for ambiguity.
- Delivery state: treat the system as UAT-ready, not production-proven, until current staging PostgreSQL load, environment, stakeholder review, UAT, parallel reconciliation, and sign-off evidence say otherwise.

Do not infer that all brands are legally “cosmetics.” Keep product regulatory class and destination market explicit.

## 5. Project terminology

| Term | Meaning |
|---|---|
| SPU | Management/reporting product family; not the transaction or BOM grain |
| SKU | Transaction, inventory, price, lot, and BOM output/input grain |
| BH | Replenishment/stocking request |
| WO | Outsourced manufacturing work order |
| PO | Purchase order for physical material lines; do not duplicate processing-fee payable |
| PC | Price-change approval |
| JG | Outsourced processing notice/order |
| FL / TL | Issue material to processor / return material from processor |
| SH | Receipt with QC disposition |
| CT | Purchase return |
| JS | Outsourced settlement and material-by-material loss calculation |
| PD | Inventory count |
| Snapshot warehouse | Point-in-time external/reference inventory, not a transactional balance |
| Outsourced warehouse | Processor material account; a negative balance may represent verified processor advance material, not generic permission for negative stock |
| Red-letter reversal | Linked compensating movement preserving the original posted fact |
| Concession receipt | Nonconforming quantity accepted under explicit approval and pricing/disposition rules |

Use the terminology in current specifications if it changes. Do not invent parallel document names.

## 6. Durable implementation invariants

Re-read `supply-chain/CLAUDE.md`; the following is a routing summary, not a substitute:

- Allocate numbers through `src/server/docflow/doc-no.ts` and `doc_counter`.
- Post inventory only through `src/server/posting/registry.ts` and the posting engine.
- Keep `stock_ledger` and `audit_log` append-only.
- Use linked reversals; never implement reverse approval.
- Use decimal strings/utilities for `decimal(14,2)` money and `decimal(14,4)` quantities.
- Update balance keys in deterministic sorted order inside a transaction.
- Enforce idempotency through unique database constraints, not pre-checks alone.
- Keep rules under `src/server/rules` pure and directly tested.
- Calculate outsourced settlement per material; never net incompatible materials.
- Enforce maker-checker separation and include approval cycle/version in idempotency.
- Re-query current authorization for writes.
- Mask sensitive fields server-side in DTOs, including exports and RSC payloads.
- Reuse shared truth-caliber modules instead of reimplementing local variants: on-hand/snapshots in `core/stock-view.ts`, open supply in `core/supply.ts`, velocity in `core/velocity.ts`, ABC in `rules/abc.ts`, and service helpers in `core/svc.ts`.
- Let reference data increase awareness, trigger visible suppression/review, or reveal coverage gaps; never let it reduce accounting truth or disappear a recommendation silently.
- Avoid server value imports from `"use client"` modules.
- Wrap list-state pages that use search params in `Suspense`; isolate multiple lists with prefixes.
- Generate and apply migrations for schema changes; account for PGlite startup migration behavior.

## 7. Known evidence traps

These were observed on 2026-07-25. Re-check rather than preserving them as permanent truth:

- `CURRENT.md` summary rows and its decision-register rows disagree for some decisions such as D10, D17, and D20. Prefer the explicit dated decision row, then test implementation.
- Embedded test totals and commit IDs disagree across sections. Run the current checks.
- `supply-chain/README.md` contains an old DW1 milestone and must not be used as status authority.
- `spec/14` checkboxes sometimes lag existing code, while schema or a route alone may still overstate end-to-end completion.
- The specification describes DB sessions in one place, while the accepted implementation uses an eight-hour JWT plus fresh DB authorization on writes. Preserve the security intent unless redesigning it explicitly.
- Background-job wiring has changed over time. Verify the real production entrypoint, singleton behavior, and idempotency instead of assuming pg-boss or an interval runner is active.
- Supplier `retired`, centralized permission policy, and full FEFO/batch execution have appeared as design directions without necessarily being complete.
- Wider-company inventory reference coverage can suppress false replenishment advice but is dated and incomplete. Re-check coverage and freshness before planning.
- A clean test suite does not establish staging/prod readiness, data coverage, user adoption, or sign-off.

## 8. Change and verification discipline

Before editing:

1. Run a focused file inventory and `git status --short --branch` inside `supply-chain`.
2. Inspect affected schema, migration history, services, API routes, UI, and tests.
3. Identify user changes and avoid overwriting them.
4. Re-check status and recent commits before committing because another session may change the shared repository concurrently.

When changing a business decision:

1. Update `spec/CURRENT.md` first as the decision register.
2. Register new discoveries or evolution work in the current roadmap/decision scheme before silently building it.
3. Update the current host specification and mark superseded text explicitly.
4. Preserve audit archives.
5. Carry the change into schema/rules/services/API/UI/permissions/tests/UAT as applicable.
6. Record owner, date, rationale, migration/transition behavior, and rollback.

Verify proportionally:

- pure logic: targeted unit and counterexample tests;
- database/state/posting: PGlite integration tests, retry/concurrency/reversal checks;
- schema: migration replay plus typecheck;
- API/security: authentication, authorization, DTO/export leakage, error semantics;
- UI: happy/empty/loading/error/permission states and affected end-to-end flow;
- full-risk changes: targeted tests first, then full `npm test`, `npm run typecheck`, and build where relevant.

The local environment may lack `rg`; prefer it when available and fall back to `find` plus
`/usr/bin/grep`. Avoid competing writers against the same `.data/dev` PGlite directory. Identify
ports and PIDs with `lsof`, stop only a process owned by the current session, and restart it after
new migrations.
