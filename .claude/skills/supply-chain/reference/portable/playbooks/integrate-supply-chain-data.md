---
name: integrate-supply-chain-data
description: Design, implement, or audit trustworthy supply-chain ingestion and integration pipelines for files, Excel, APIs, ERP/OMS/WMS/3PL/RPA feeds, migrations, staging, aliases, lineage, reconciliation, replay, and outbox delivery. Use when data crosses a system boundary or changes representation. Pair with protect-supply-chain-ledgers only when released data posts transactional facts.
---

# Integrate Supply Chain Data

Build boundary flows that are replayable, explainable, and reconcilable without turning external claims into internal truth silently.

## Own one boundary

Answer: **How does this data cross systems or representations without losing meaning or control?**

- Own extraction, contracts, staging, mapping, identity, lineage, release, delivery, and reconciliation.
- Let `$protect-supply-chain-ledgers` own atomic posting when an approved import creates inventory or financial facts.
- Let `$govern-cosmetics-quality` own the regulatory or quality meaning of transported evidence.
- Let `$release-supply-chain-safely` own candidate-level ship verification.

## Orient and classify

1. Identify producer, consumer, owner, protocol, cadence, business date, data as-of time, timezone, coverage, and expected latency.
2. In this project, locate and read `spec/CURRENT.md`, then `supply-chain/CLAUDE.md`, before changing code.
3. Inspect the actual contracts, schemas, import jobs, mappings, aliases, migrations, routes, outbox, logs, reconciliation, and tests in scope.
4. Classify each incoming field as master/version data, workflow data, immutable event, external reference, snapshot, derived result, or recommendation.
5. Name the authoritative source and correction path for every released fact.

Treat files, API responses, RPA captures, and partner labels as claims until they pass validation and release.

## Design the canonical pipeline

Use the smallest pipeline that preserves these stages:

1. **Capture:** preserve original bytes or payload, source identity, fetch time, business time, filename or message ID, and content hash.
2. **Stage:** load losslessly into an isolated batch. Never mutate production facts during parsing.
3. **Normalize:** apply versioned aliases, identifiers, units, decimals, currencies, timezones, enum mappings, and canonical shapes.
4. **Validate:** run structural, semantic, referential, uniqueness, freshness, authorization, and cross-row checks.
5. **Review:** quarantine rejected or ambiguous rows with reason codes and safe remediation; never coerce unknown into zero.
6. **Release:** promote only approved rows through an explicit, idempotent boundary.
7. **Deliver:** use an outbox or equivalent durable handoff for side effects; assume at-least-once delivery.
8. **Reconcile:** prove control totals, row disposition, consumer acknowledgement, and business-level outcomes.
9. **Observe:** expose batch status, lag, errors, replay history, supersession, and owner-facing alerts.

Do not add orchestration infrastructure when a transactional job plus durable outbox is sufficient.

## Preserve identity and meaning

Define separately:

- source record identity;
- canonical business identity;
- event identity;
- batch and row identity;
- idempotency key and payload fingerprint;
- alias namespace, effective dates, and version;
- ownership, location, unit, lot or batch, quality state, and business time.

Use decimal-safe types for quantities and money. Reject incompatible units unless an approved, versioned conversion exists. Preserve raw value and normalized value with mapping provenance.

Never use `MAX(id)+1`, filename alone, row number alone, or an in-memory check as the uniqueness boundary.

## Control mutations and delivery

- Enforce uniqueness and idempotency in the database at every release or consumer boundary.
- Commit internal facts and outbox intent in one transaction.
- Make consumers safe for duplicates, retries, late delivery, and out-of-order delivery.
- Model correction as supersession, reversal, or a new effective-dated version according to fact type; do not erase lineage.
- Keep external stock snapshots and transaction ledgers separate. A snapshot may annotate, compare, suppress advice, or open an exception, but must not post stock silently.
- Revalidate state, permissions, and payload before consequential release.
- Mask secrets and sensitive fields in staging views, errors, exports, logs, and dead-letter tools.

## Engineer failure as a normal path

Define behavior for:

- missing or extra columns, schema drift, encoding, truncation, and malformed rows;
- duplicate files, duplicate messages, changed content under the same source key, and replay;
- unknown aliases, ambiguous identities, stale snapshots, and late corrections;
- partial partner outage, timeout after commit, poison messages, and dead letters;
- consumer version mismatch, reordered events, and reconciliation mismatch;
- manual repair, resubmission, supersession, and audit review.

Prefer explicit row outcomes: accepted, rejected, quarantined, duplicate, superseded, and pending review.

## Verify with adversarial fixtures

Test:

- exact replay and same key with different payload;
- concurrent release attempts;
- decimal scale, sign, locale, timezone, and unit boundaries;
- unknown, stale, null, and zero values;
- partial file and partial downstream failure;
- out-of-order and late messages;
- wrong tenant, legal entity, warehouse, supplier, product, lot, or permission;
- reconciliation before and after replay or recovery.

Prove that invalid input has no unauthorized side effects and that a released batch can be traced back to its raw source.

## Deliver a lean integration contract

Report:

1. boundary, owners, authority, cadence, and service expectation;
2. source-to-canonical mapping with semantics and versions;
3. identities, keys, validation rules, and row outcomes;
4. release transaction, event contract, replay, and correction behavior;
5. security, observability, reconciliation, and operating ownership;
6. representative fixtures, acceptance tests, and unresolved data decisions.

Separate observed source behavior from proposed contract and inferred meaning.
