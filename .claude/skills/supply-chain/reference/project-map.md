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

Treat a repository root as this project when it contains:

- `docs/NOW.md`
- `docs/spec/CURRENT.md`
- `package.json`
- `src/server/posting/`
- `CLAUDE.md`

Launch repository skills from that root. Resolve it with `git rev-parse --show-toplevel`; search only
provided workspace roots if the project moved. Never route live decisions outside the Git root,
hard-code a personal path, or recursively search a broad home/filesystem root.

## 2. Authority and reading order

Within the repository, only two documents are live authority:

1. **Current status and next priority:** `docs/NOW.md`.
2. **Current approved intent and decisions:** `docs/spec/CURRENT.md`, which navigates to supporting
   host specifications. Those host documents do not independently override a later explicit ruling.

Keep the other layers distinct:

3. **Repository operating contract:** `CLAUDE.md` / `AGENTS.md`.
4. **Implemented behavior:** schema, migrations, services, rules, routes, jobs, UI, configuration,
   and the exact revision.
5. **Verified behavior:** reproducible tests, UAT, queries, logs, API/UI observations, and
   reconciliation artifacts.
6. **Deployed behavior:** deployed revision, environment configuration, telemetry, operational
   reconciliation, and sign-off evidence.
7. **History and rationale:** supporting specifications, audit archives, original inputs, meeting
   notes, skill history, and git history.

A current user ruling can supersede repository intent for the task, but it is not durable project
authority until recorded in `docs/spec/CURRENT.md`.

Resolve conflicts explicitly:

- Quote or point to both competing statements.
- Identify which source claims authority and whether the implementation agrees.
- Classify the mismatch as stale documentation, incomplete implementation, or unresolved decision.
- Never select a convenient answer silently.

Do not trust embedded commit IDs, test counts, data volumes, or “complete” labels without current verification.

## 3. Task-to-document router

| Task | Read first | Then inspect |
|---|---|---|
| Current status or next priority | `docs/NOW.md` | git status/log, linked evidence, relevant code and tests |
| Current ruling, scope, or acceptance | `docs/spec/CURRENT.md` | the supporting sections it names, then affected routes/services/tests |
| Core entities, state machines, permissions | `docs/spec/CURRENT.md` | named host specs, `src/db/schema`, `docflow`, DTOs, APIs |
| Data import, master data, snapshots, lineage | `docs/spec/CURRENT.md` | named data specs, adapters, staging/release engine, refs, migrations, tests |
| Product requirements and omitted intent | `docs/spec/CURRENT.md` | named original inputs/audits and current implementation |
| Supplier lifecycle | `docs/spec/CURRENT.md` | supplier schema/service/UI, scorecard, alerts |
| Automatic outsourced-production chain | `docs/spec/CURRENT.md` | auto-chain, kitting/ATP rules, approval and posting boundaries |
| SPU/SKU policy | `docs/spec/CURRENT.md` | masters schema, aliases, release/regroup logic |
| Platform evolution/AI/planning | `docs/NOW.md`, `docs/spec/CURRENT.md` | rules, projections, reports, jobs, data coverage |
| Audit history or rationale | `docs/spec/CURRENT.md` | named archives, then current files to test whether a finding remains true |

Read a referenced section in context. A heading hit alone is not sufficient when a later paragraph amends it.

## 4. Current business and technical shape

Verify these live before relying on them:

- Business: multi-brand cosmetics/consumer-goods company, hundreds of finished-product SKUs, large component/raw-material catalog, outsourced/OEM production, Excel and external-system data sources, rapid growth, omnichannel inventory blind spots.
- Core flow: `BH → WO → PO + JG → FL/TL → SH + QC → RK → JS`, with CT purchase returns, stock documents, counts, reversals, reconciliation, and external references.
- Architecture: Next.js App Router + TypeScript + React + Ant Design; PostgreSQL/PGlite + Drizzle; NextAuth; pg-boss; Vitest/PGlite.
- Shape: modular monolith with server modules, pure rules, a central posting engine, a unified approval/state layer, imports through staging/release, and reports/decision support.
- Data states: transactional ledger for controlled warehouses, external snapshots/reference facts for other coverage, derived planning views, and review queues for ambiguity.
- Delivery state: treat the system as UAT-ready, not production-proven, until current staging PostgreSQL load, environment, stakeholder review, UAT, parallel reconciliation, and sign-off evidence say otherwise.
- External data layer (2026-09-02): Jiandaoyun is the only live external source (19 explicit contracts into observation staging; JST/Yonyou blocked by platform authorization). Read models over it are `observation_only` and cached in `report_read_model_cache` bound to exact batches: `external-demand-signal`, `external-velocity`, `platform-sku-identity-gap`, `channel-observation`, `tmall-channel-contribution`. Platform identity is the bottleneck; claims go through `master/platform-sku-claim.ts` only.
- Deployment (laptop): production compose stack `supply-chain` on port 3100, public entry via Cloudflare quick tunnel (HTTP/2) managed by a launchd daemon in `~/Library/Application Support/exp-scm/`; link rotates on tunnel rebuild and is announced to Feishu. See `docs/guides/对外访问方案-选型与步骤.md`.

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

Re-read `CLAUDE.md`; the following is a routing summary, not a substitute:

- Allocate numbers through `src/server/docflow/doc-no.ts` and `doc_counters`.
- Post inventory only through `src/server/posting/registry.ts` and the posting engine.
- Keep `stock_ledger` and `audit_logs` append-only.
- Use linked reversals; never implement reverse approval.
- Follow each schema field's precision contract: document amounts/prices are usually
  `decimal(14,2)`, explicitly higher-precision unit costs may be `decimal(14,4)`, business
  quantities are usually `decimal(14,4)`, and aggregate control totals may be wider. Always use
  decimal strings/utilities rather than floating-point business arithmetic.
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

- `docs/spec/CURRENT.md` summary rows and its decision-register rows have disagreed for some
  decisions. Prefer the latest explicit dated decision row, then test implementation.
- Embedded test totals and commit IDs disagree across sections. Run the current checks.
- `README.md` is onboarding material, not status or decision authority.
- Supporting `docs/spec/14-系统进化总PRD.md` checkboxes may lag existing code, while schema or a
  route alone may still overstate end-to-end completion.
- The specification describes DB sessions in one place, while the accepted implementation uses an eight-hour JWT plus fresh DB authorization on writes. Preserve the security intent unless redesigning it explicitly.
- Background-job wiring has changed over time. Verify the real production entrypoint, singleton behavior, and idempotency instead of assuming pg-boss or an interval runner is active.
- Supplier `retired`, centralized permission policy, and full FEFO/batch execution have appeared as design directions without necessarily being complete.
- Wider-company inventory reference coverage can suppress false replenishment advice but is dated and incomplete. Re-check coverage and freshness before planning.
- A clean test suite does not establish staging/prod readiness, data coverage, user adoption, or sign-off.

- A read-model cache can mask new logic: `report_read_model_cache` rows are keyed by `key` + `source_binding`; if logic changes without bumping the key version, pages keep serving the old payload. Verify with a fresh compute, not the API alone.
- Windowed Jiandaoyun batches (`contract.window`) are rolling snapshots, not full snapshots: row counts legitimately shrink and old records legitimately disappear; never read one batch as the population.
- launchd-spawned processes cannot read `~/Downloads` (TCC); "file not found" from a LaunchAgent usually means this, not a missing file.
- The public URL is ephemeral: any evidence citing a `trycloudflare.com` host is stale the moment the tunnel rebuilds; use `npm run access:link`.

## 8. Change and verification discipline

Before editing:

1. Run a focused file inventory and `git status --short --branch` inside `supply-chain`.
2. Inspect affected schema, migration history, services, API routes, UI, and tests.
3. Identify user changes and avoid overwriting them.
4. Re-check status and recent commits before committing because another session may change the shared repository concurrently.

When changing a business decision:

1. Update `docs/spec/CURRENT.md` first as the decision register.
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
