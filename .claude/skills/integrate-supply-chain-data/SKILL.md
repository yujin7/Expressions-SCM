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

Use [file-release.md](references/file-release.md) for file ingestion,
[single-claim.md](../supply-chain/reference/single-claim.md) to test one factual claim, and
[reachability.md](../supply-chain/reference/reachability.md) to trace a fact from writer to caller.
