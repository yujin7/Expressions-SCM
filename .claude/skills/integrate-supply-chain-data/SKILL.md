---
name: integrate-supply-chain-data
description: Design, implement, run, or audit trustworthy supply-chain ingestion and integration pipelines for files, Excel, APIs, ERP, WMS, marketplaces, cross-system data migrations, master data, and exports. Use when data crosses a source, staging, or system boundary; for mappings, aliases, replay, reconciliation, lineage, or parsed-but-not-persisted fields. Do not use for an in-place schema migration backfill; use schema-change.
---

# Integrate Supply-Chain Data

Move external claims into governed system facts without losing identity, provenance, precision, or
the ability to replay and reconcile them. Prefer one explicit staged pipeline over source-specific
shortcuts.

## Define the contract before the connector

Record:

- business owner, technical owner, source system, target system, and system of record;
- entity, grain, natural key, source identifier, version, and delete/correction semantics;
- quantity, unit, currency, tax, timezone, business date, lot or batch, owner, location, and
  quality status where relevant;
- delivery mode, expected cadence, lateness window, schema version, and compatibility policy;
- coverage, freshness, control totals, reconciliation tolerance, retention, and replay window;
- privacy classification, allowed roles, masking, audit, and evidence requirements.

Keep missing, unknown, stale, rejected, estimated, and zero distinct. Do not infer a unit, entity,
warehouse, supplier, lot, or effective date from an ambiguous label.

## Use one visible lifecycle

`receive → fingerprint → preserve raw → parse → normalize → validate → stage → review → release → reconcile → observe`

1. **Receive:** authenticate the source and capture filename or event ID, checksum, schema
   version, received time, and source as-of time.
2. **Preserve raw:** retain the immutable source artifact or event envelope with access controls.
3. **Parse:** produce typed rows with source-row lineage; never overwrite the raw claim.
4. **Normalize:** resolve identifiers, units, dates, decimals, aliases, and enums through versioned
   mappings.
5. **Validate:** separate structural errors, semantic errors, policy conflicts, duplicates, and
   ambiguous mappings.
6. **Stage:** keep rejected and unresolved rows visible with stable reason codes and owners.
7. **Review:** require human decisions for ambiguous identity, destructive replacement, quality
   eligibility, or irreversible financial/inventory effects.
8. **Release:** promote only validated facts through the target domain's authorized service,
   posting, approval, and audit boundaries.
9. **Reconcile:** compare source, staged, accepted, rejected, superseded, and target counts and
   measures at the same grain.
10. **Observe:** alert on freshness, drift, backlog, repeated rejects, reconciliation variance, and
    silent zero-volume runs.

External snapshots and reference quantities never become transactional stock merely because they
arrived through a trusted connector.

## Make replay safe

- Derive an immutable idempotency key from source identity plus business key and version.
- Treat delivery as at least once; duplicate receipt must return the first committed outcome.
- Define behavior for late, out-of-order, corrected, and deleted source records.
- Preserve mapping and rule versions so a result can be replayed.
- For replacements, use versioned supersession or bounded snapshot replacement; never silently
  mutate historical evidence.
- For outbound work, use an outbox or another durable handoff when the domain transaction and
  transport cannot commit atomically.
- Quarantine poison messages with reason, retry policy, attempt history, and a named owner.

## Protect identity and arithmetic

- Use decimal-safe quantity and money calculations and explicit timezone conversion.
- Retain original value and unit alongside normalized values.
- Reject conflicting aliases; never resolve a collision by first match or fuzzy optimism.
- Distinguish master data, workflow documents, immutable movements, snapshots, derived measures,
  recommendations, and human decisions.
- Do not let imports write inventory balances, approve documents, release quality holds, or alter
  settlement facts outside their canonical domain boundaries.
- Revalidate authorization and target state when a staged decision is committed.

## Project file-release mode

For this repository's upload → `staging_rows` → review → release pipeline, follow
[file-release.md](references/file-release.md). Its examples are historical evidence: rerun counts
and verify paths before treating them as current. The non-negotiable project behaviors are:

- dry-run produces full counts and **zero writes**;
- alias collisions and ambiguous BOM or unit mappings enter human review;
- release, master-data updates, posting, and audit share the intended transaction boundary;
- rerunning the same source is idempotent or explicitly supersedes a prior version;
- the report names committed, blocked, unresolved, and reconciled counts separately;
- opening or migrated inventory uses the approved migration posting path, never a balance update.

Use `$reconcile-supply-chain-truth` when a parsed field appears disconnected. Use
`$write-path` when accepted data becomes a transactional fact. Use `$schema-change` when the
target contract itself changes.

## Verify the full story

Test, as applicable:

- valid, empty, malformed, oversized, and duplicate inputs;
- wrong encoding, formula cells, merged cells, hidden rows, locale decimals, and timezones;
- unknown, colliding, and later-corrected aliases;
- partial batch failure, timeout, retry, restart, and concurrent delivery;
- out-of-order update and delete or tombstone behavior;
- permission, masking, logs, downloads, and rejected-row visibility;
- source-to-target control totals and row-level lineage;
- replay after mapping or code changes without duplicating facts.

Report the exact source/as-of time, accepted/blocked/unresolved/superseded counts, reconciliation
variance, and remaining owner. Never summarize a nonzero blocked queue as "all successful."
