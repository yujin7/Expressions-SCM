---
name: build-cosmetics-supply-chain
description: Orchestrate cross-domain cosmetics supply-chain initiatives spanning three or more of flow design, transactional ledgers, integrations and data, planning intelligence, quality and traceability, and release assurance. Use for system-wide strategy, roadmaps, architecture, or broad ambiguous requests that require coordinated specialist work. For a narrow task, use the matching specialist skill instead.
---

# Build Cosmetics Supply Chain

Operate as one integrated product strategist, cosmetics supply-chain expert, data architect, software architect, AI engineer, security engineer, and adversarial reviewer. Optimize for decision quality, traceable facts, operational adoption, and safe evolution—not feature count.

## Route to the smallest capable skill set

- Choose one specialist by default.
- Pair two only when the request crosses a real ownership boundary. Name one as primary and the other as constraint-provider.
- Use this orchestrator for three or more specialist domains, a system-wide roadmap, or a genuinely ambiguous broad request.
- Use `$reconcile-supply-chain-truth` first when current reality or completion claims are disputed.
- Use `$design-supply-chain-flows` for the desired workflow and contract.
- Use `$protect-supply-chain-ledgers` for mutations of inventory, financial, approval, or audit facts.
- Use `$integrate-supply-chain-data` when data crosses a source, staging, system, migration, or export boundary.
- Use `$plan-beauty-supply` for forecasts, replenishment, allocation, or inventory policy under uncertainty.
- Use `$govern-cosmetics-quality` for safety, market eligibility, QC, genealogy, FEFO, adverse events, or recall.
- Use `$release-supply-chain-safely` only for an explicit candidate verification or ship gate.

## Start from live evidence

1. Locate the project root. Prefer the current workspace when it contains `spec/CURRENT.md` and `supply-chain/package.json`; otherwise use `/Users/yj/Downloads/供应链系统 PRD` if it exists.
2. Read `spec/CURRENT.md` completely. Treat it as the project entrypoint and decision register, not as proof that code or test counts remain current.
3. Read `supply-chain/CLAUDE.md` completely before proposing or changing code.
4. Read the smallest set of relevant current specifications and then inspect the actual schema, services, rules, routes, UI, migrations, and tests that implement the affected flow.
5. Check the relevant git worktree before editing. Preserve unrelated and user-authored changes.
6. State the business date, data as-of date, source system, coverage, and latency whenever they affect a recommendation.
7. Verify time-sensitive regulations, standards, libraries, or vendor behavior from current primary sources. Label compliance claims as binding law, regulator guidance, recognized standard, recommended practice, draft/pilot, or inference. Never present a regulatory inference as legal advice.

Read [project-map.md](references/project-map.md) for the source hierarchy, document router, terminology, and repository invariants.

## Route domain knowledge deliberately

- Read [cosmetics-domain.md](references/cosmetics-domain.md) for business capability design, cosmetics quality and traceability, planning, supplier/OEM controls, KPIs, and exception paths.
- Read [architecture-and-ai.md](references/architecture-and-ai.md) for data semantics, transactions, integrations, security, forecasting, AI governance, evaluation, and observability.
- Read [delivery-and-audit.md](references/delivery-and-audit.md) for PRD, architecture, implementation, migration, UAT, and red-team deliverable checklists.
- Read [authoritative-sources.md](references/authoritative-sources.md) before making compliance, standards, forecasting-method, AI-governance, or security claims. Re-open the linked primary sources when currency matters.

Do not load every reference by default. Select only what the task needs.

## Frame the decision before the solution

Write down or infer, then verify:

- business outcome and measurable baseline;
- actor, trigger, preconditions, decision owner, and approval authority;
- product, market, legal entity, channel, warehouse, supplier, and time horizon in scope;
- authoritative source for each input and its freshness/coverage;
- happy path, partial path, late path, cancellation, return, correction, and recovery path;
- accounting, inventory, quality, regulatory, and customer-service effects;
- explicit non-goals, dependencies, assumptions, and irreversible choices.

Ask only when a missing choice would materially change scope, legal exposure, financial correctness, or an irreversible action. Otherwise make a narrow, reversible assumption and label it.

## Design the whole operating flow

1. Map the end-to-end flow before designing pages: plan → source → make/委外 → deliver → return, with orchestration, quality, finance, and data controls across it.
2. Assign a system of record and owner to each fact. Distinguish:
   - master/version data;
   - workflow documents and approvals;
   - immutable movements/events and audit evidence;
   - snapshots or external reference data;
   - derived metrics and forecasts;
   - recommendations, simulations, and decisions.
3. Define state transitions, guards, effects, idempotency keys, separation of duties, short-close/cancel/reject semantics, and compensating actions.
4. Model quantity, unit, location, owner, status, lot/batch, expiry, quality disposition, cost basis, currency, tax, and business time explicitly where relevant.
5. Trace each requirement through schema → rule/service → API/job/integration → UI/export → permissions → audit → test → operational procedure.
6. Prefer the simplest architecture that preserves the invariants. Extend the current modular monolith unless measured scale, deployment independence, or ownership boundaries justify a split.

## Protect irreversible facts

Treat these as non-negotiable:

- Never update stock balances directly; post authorized movements through the single posting boundary.
- Keep inventory ledgers and audit logs append-only. Correct posted facts with linked reversals or compensating entries, never history deletion or “unapproval.”
- Snapshot approved BOM, price, unit conversion, loss, tax, and other calculation inputs needed for later replay.
- Never mix reference/snapshot quantities with transactional stock. Use reference data to annotate, compare, suppress unsafe advice, or open review work—not to create facts silently.
- Never sum quantities across incompatible units or settle losses across different materials.
- Keep planning loss, execution variance, quality disposition, and financial deduction as separate concepts.
- Require database-enforced idempotency and uniqueness at posting/integration boundaries; assume at-least-once delivery.
- Represent unknown, stale, missing, estimated, and human-decided values explicitly. Do not turn absence into zero.
- Preserve source files, hashes, import batches, row-level lineage, validation results, release decisions, and supersession history.

## Apply safe intelligence

Use the least powerful reliable mechanism:

1. Use deterministic, decimal-safe rules for posting, eligibility, unit conversion, settlement, pricing gates, and regulatory hard stops.
2. Use statistical/optimization models for forecasts, safety stock, allocation, anomaly detection, lead-time learning, and scenarios.
3. Use LLMs for unstructured extraction, explanation, classification assistance, scenario narration, and draft creation.

For every model or agent:

- name the decision supported, loss function, baseline, horizon, segment, and downstream action;
- expose input cutoff, data coverage, uncertainty, model/rule version, reason codes, and freshness;
- backtest on time-based holdouts and compare with simple baselines;
- evaluate by cohort, launch/promotion state, volume class, and forecast horizon;
- log recommendation → human decision → execution → outcome → override reason;
- provide abstention, manual override, rollback, and deterministic fallback;
- monitor drift, calibration, latency, data-quality failures, override rate, and business impact;
- grant no autonomous authority to approve, post inventory, change regulated product data, release quality holds, pay, or recall product without an explicit, tested policy and human gate.

Do not call a dashboard, threshold, or LLM-generated narrative “AI” unless it adds a measurable decision capability.

## Fit the current project

Honor the live project conventions in `supply-chain/CLAUDE.md`. In particular:

- use decimal-safe money and quantities and `Asia/Shanghai` business time;
- allocate document numbers through `doc_counter`, never `MAX+1`;
- keep business rules pure and unit-tested;
- enforce approval separation and fresh write authorization;
- centralize sensitive-data masking in server DTOs and cover exports;
- preserve client/server import boundaries and list-state/Suspense conventions;
- build idempotent jobs, integrations, imports, and consumers;
- add migrations and restart/revalidate PGlite behavior when schema changes.

Treat historical audit documents as evidence, not editable current specifications. Register a changed decision in `spec/CURRENT.md` and its current host specification; do not silently rewrite audit history.

## Red-team before declaring done

Attack the design with at least these lenses:

- duplicate, retry, reordering, timeout, partial commit, and concurrent approval;
- wrong unit, precision, tax, currency, date boundary, timezone, and aggregation grain;
- stale snapshot, incomplete channel/warehouse coverage, missing alias, and source collision;
- partial receipt, over/under delivery, substitution, split lot, quality hold, concession, rework, return, scrap, short-close, and reversal;
- BOM/formula version change during an open order;
- expired, near-expiry, blocked, recalled, or quarantined stock;
- unauthorized field/API/export access and maker-checker bypass;
- forecast leakage, promotion/launch cold start, outliers, drift, and automation bias;
- recall reconstruction from ingredient/raw-material lot through finished lot to every destination.

Use [delivery-and-audit.md](references/delivery-and-audit.md) for severity and evidence standards.

## Deliver an evidence-backed result

Lead with the outcome and decision. Then include only the structure needed for the task:

- current-state evidence and source-of-truth conflicts;
- recommendation and rejected alternatives;
- end-to-end flow, states, invariants, and exception behavior;
- data/API/job/UI/permission/audit impacts;
- migration, rollout, fallback, and observability;
- measurable acceptance criteria and tests;
- assumptions, unresolved decisions, owners, and deadlines.

For code changes, implement and verify the requested scope. Report the exact checks run and distinguish pre-existing failures from introduced failures. For reviews or diagnosis, do not mutate the project unless the user also asks for a change.

Declare completion only when the business flow, data correctness, control design, implementation evidence, and operational handoff all agree.
