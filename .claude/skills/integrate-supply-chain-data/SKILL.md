---
name: integrate-supply-chain-data
description: Design, implement, or audit supply-chain ingestion, Excel/API/ERP/WMS integrations, master-data mapping, schema evolution, migrations, reconciliation, replay, lineage, coverage, or claims about current system truth. Use whenever facts cross a source, storage, schema, or system boundary.
---

# Integrate Supply Chain Data

Move claims into governed facts without losing identity, precision, provenance, or replayability.

Use this as the only primary skill while facts cross a source, staging, schema, or truth boundary.
Hand off sequentially to `write-path` only when accepted facts enter an application-owned mutation,
then to `release-sweep` only after an exact candidate exists.

## Evidence contract

1. Record source and target owners, system of record, grain, natural key, version, units, timezone, correction semantics, cadence, and coverage.
2. Use one lifecycle: received → parsed → validated → staged → reconciled → released or rejected.
3. Keep raw source evidence immutable; make mappings and releases versioned and idempotent.
4. Reconcile counts, quantities, amounts, key coverage, rejects, freshness, and duplicates before promotion.
5. Treat missing, unknown, stale, rejected, estimated, and zero as different states.

## Schema and truth

- Establish a falsifiable claim and anchor revision, environment, data cutoff, and scope.
- Compare intended, implemented, verified, and deployed behavior; do not infer reachability from file presence.
- Prefer additive schema changes, explicit backfills, compatibility windows, and tested recovery.
- Generate migrations from the project workflow; restart local PGlite after schema changes and verify `/api/health`.
- Never edit production-like data or run a backfill without an exact target, dry run, control totals, and recovery path.

## Refusing a batch

A refusal needs a diagnosable scope and a recovery path. On 2026-09-04 one full-snapshot
stream went 6448 → 6447 rows without identifying the missing record. That stream's failure
could stop later streams in the same sequential job; it did not prove that every stream or
the whole connector had stopped. Check per-stream runs, not only the parent job status.

- Report missing IDs and the observed shape, but distinguish **evidence** from **hypothesis**:
  historical rows are ordered by saved `rowNo` (normalized source-record-ID order), not API page
  arrival order. Validate that sequence before using a tail heuristic. A missing tail suggests an
  integrity risk; neither tail nor scattered gaps prove deletion, pagination failure, or permissions.
  Check the upstream record and extraction scope before accepting a smaller baseline.
- Accepting a shrunken baseline needs a per-record signature, never a blanket switch:
  `integration_record_deletions` + `src/server/integrations/deletion-ack.ts` (admin, mandatory
  reason, audited, revocable, and impossible to pre-sign for a record the system never saw).
- **A tombstone must never launder a truncation.** Judge the shape over *everything* that vanished,
  not just the unsigned remainder — otherwise signing each missing row turns a truncated batch into
  an accepted one. Even a source-confirmed deletion that matches the guarded tail shape stays
  blocked under the current rule; escalate recovery for explicit review, never bypass the guard.
  `tests/integrations/jiandaoyun-sync.test.ts` pins both directions.
- Row-count floors must subtract acknowledged deletions, or the first successful release trips a
  bogus "duplicate source id" error.
- Apply full-snapshot guards only to full snapshots. Rolling-window contracts and empty observations
  keep their own existing evidence/retention rules; never silently reinterpret them as replacements.

Use [file-release.md](references/file-release.md) for file ingestion,
[single-claim.md](../supply-chain/reference/single-claim.md) to test one factual claim, and
[reachability.md](../supply-chain/reference/reachability.md) to trace a fact from writer to caller.
