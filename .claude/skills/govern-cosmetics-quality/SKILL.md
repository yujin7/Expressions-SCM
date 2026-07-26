---
name: govern-cosmetics-quality
description: Design, implement, audit, and operate cosmetics quality, batch and lot traceability, expiry and FEFO, market eligibility, complaints, adverse events, and recall controls. Use for formula, ingredient, packaging, supplier or OEM qualification, QC sampling and release, CoA, deviation, concession, rework, quarantine, genealogy, recall scope, regulatory evidence, or the related schemas, workflows, APIs, UI, tests, and incident playbooks.
---

# Govern Cosmetics Quality

Make every release, hold, and recall decision reconstructable from current evidence. Prefer a small, explicit control system over a broad compliance platform.

## Start from live evidence

1. Resolve the repository root with `git rev-parse --show-toplevel`; do not depend on a machine-specific absolute path.
2. Read `../spec/CURRENT.md` fully, then `CLAUDE.md` before proposing or changing code.
3. Read only the relevant current specification, then inspect the actual schema, services, routes, UI, migrations, and tests before claiming a capability exists.
4. Check the worktree before editing and preserve unrelated changes.
5. Treat historical audit documents as evidence, not current requirements.

For every time-sensitive regulatory or standards claim, verify a current primary source. Use
[authoritative-sources.md](../supply-chain/reference/authoritative-sources.md) only as a dated
research index, reopen the primary source, and record its jurisdiction, publisher, publication or
effective date, access date, and status as binding law, regulator guidance, recognized standard,
recommended practice, draft or pilot, or inference. Cite the exact provision that affects the
design. If authoritative currency cannot be verified, say so, abstain from a compliance
conclusion, and route the question to qualified regulatory or legal review.

## Define the quality decision

Establish:

- product, SKU, formula and BOM version, packaging or artwork version, and target market;
- legal entity, responsible site, manufacturer or OEM, supplier, warehouse, and channel;
- ingredient, raw-material, packaging-component, bulk, finished-goods, and shipment lots in scope;
- specification, test method, sampling plan, acceptance limits, evidence cutoff, and decision owner;
- requested disposition: sample, test, hold, release, reject, concession, rework, scrap, return, withdraw, or recall;
- customer, inventory, regulatory, financial, and service effects;
- unknown facts, explicit assumptions, and conditions that require abstention.

Never infer a release, market eligibility, shelf life, or recall boundary from missing data.

## Build replayable genealogy

1. Trace supplier and source lot → received lot → sample and test → consumed raw-material or component lot → bulk or intermediate batch → finished batch → pack configuration → warehouse movement → shipment and destination.
2. Preserve split, merge, substitution, rework, relabel, repack, return, destruction, and reversal links.
3. Version product, formula, specification, test method, supplier and site approval, label or artwork, and market-eligibility evidence independently.
4. Record quantity, unit, status, owner, location, manufacture date, expiry or retest date, business time, source, and evidence lineage at every relevant link.
5. Represent missing or uncertain links explicitly. Widen containment and recall candidates when genealogy is incomplete; never narrow scope by optimistic inference.
6. Keep genealogy and quality events append-only. Correct errors through linked supersession or compensating events.

Use identifiers such as GTIN, GLN, SSCC, or EPCIS events only when the operating model or integration needs them; do not introduce a standards program merely to rename internal identifiers.

## Separate facts, states, and authority

Keep these concepts distinct:

- physical receipt and location;
- sampling custody;
- observed result and its unit;
- specification and method version;
- quality disposition;
- inventory availability;
- market eligibility;
- complaint or adverse-event assessment;
- containment, withdrawal, and recall execution.

Define a guarded state machine rather than editable status fields. Require deterministic checks for required tests, valid methods, calibrated units, specification version, unresolved deviations, expiry, supplier and site approval, and target-market eligibility. Make release, concession, rework, scrap, and recall decisions attributable to authorized humans with fresh authorization and separation of duties.

Do not mutate stock balances from a quality workflow. Send approved availability or disposition effects through the authoritative inventory boundary with idempotency and audit evidence.

## Control the operating flow

### Qualification and change

- Link supplier, site, raw material, formula, process, packaging, specification, and market changes to risk assessment and approval.
- Define what evidence expires and what change forces requalification, retesting, relabeling, or a new product version.
- Preserve the approved inputs used for each historical batch.

### Receipt, test, and disposition

- Quarantine by default when required evidence is absent, stale, inconsistent, or out of specification.
- Preserve CoA and laboratory evidence as source artifacts with hashes and row-level lineage where imported.
- Keep observed results immutable; issue corrected results as linked revisions.
- Treat a statistical anomaly as a review signal, never as a substitute for a specified test or authorized disposition.

### Shelf life and FEFO

- Store manufacture, expiry, retest, opened-period, and near-expiry policy separately when they apply.
- Apply FEFO only among inventory that is eligible for the destination and quality use.
- Test timezone, inclusive-boundary, relabel, retest, returned-goods, and missing-expiry behavior.

### Complaint, adverse event, and recall

1. Preserve intake evidence and deduplicate without losing reports.
2. Route safety signals immediately to the accountable human team; do not wait for automated certainty.
3. Contain potentially affected stock and destinations using the broadest evidence-supported scope.
4. Reconstruct upstream and downstream genealogy, quantities, locations, dispositions, and unknown gaps.
5. Require human authority for seriousness, reportability, market action, recall class or level, public communication, and regulatory submission.
6. Track notifications, acknowledgements, returns, reconciliation, destruction, effectiveness checks, and closure evidence.

## Apply safe intelligence

- Use deterministic rules for eligibility, required evidence, hard regulatory stops, expiry, disposition transitions, authorization, and recall set construction.
- Use statistical models for anomaly detection, complaint-signal prioritization, sampling optimization, and risk ranking only after validating data coverage and false-negative cost.
- Use LLMs for document extraction, evidence summarization, terminology mapping, draft investigation narratives, and operator assistance.

Expose source cutoff, coverage, uncertainty, rule or model version, and reason codes. Require abstention when identity, version, unit, market, evidence freshness, genealogy, or authorization is unresolved.

Never let an agent autonomously release a hold, approve a supplier or site, change a formula or specification, declare legal compliance, assess reportability, narrow recall scope, notify a regulator, or close a recall. An agent may assemble evidence and draft the action; the accountable human must decide and the system must revalidate current state at execution.

## Verify adversarially

Test at least:

- wrong formula, specification, method, market, site, supplier, lot, unit, or date version;
- duplicate results, late results, corrected results, retries, concurrent approvals, and partial commits;
- split or merged lots, substitutions, rework, repack, relabel, returns, and destroyed stock;
- expired, near-expiry, quarantined, conditionally released, blocked, and recalled inventory;
- incomplete genealogy, missing destination acknowledgements, over-recovered quantities, and cross-market leakage;
- maker-checker bypass, stale authorization, sensitive-data exposure, and export masking;
- false-positive and false-negative model behavior, drift, automation bias, and unsafe non-abstention.

Trace each accepted requirement through schema → rule or service → API or job → UI and export → permission → audit → test → operating procedure. For code changes, run the narrow unit and integration tests first, then the relevant regression, migration, build, and restart checks.

## Deliver a lean result

Lead with the quality decision and whether evidence is sufficient. Include only:

- scope, evidence cutoff, primary-source citations, and unresolved assumptions;
- genealogy coverage and material gaps;
- state transitions, deterministic guards, human authorities, and exception paths;
- affected inventory, destinations, markets, and containment actions;
- implementation impacts and measurable acceptance tests;
- owner, deadline, next review point, and explicit abstentions.

Do not claim “compliant,” “released,” “traceable,” or “recall complete” without evidence that the end-to-end control and reconciliation actually hold.
