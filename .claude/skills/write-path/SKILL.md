---
name: write-path
description: Build or change a database mutation, service write, approval, posting, settlement, pricing, import release, or application-owned insert/update/delete. Use when transactional integrity, fresh authorization, numbering, precision, idempotency, audit, inventory, money, or reversal semantics matter.
---

# Write Path

No business invariant is real unless it has one enforced entry point and adversarial tests.

Use this as the only primary skill for application-owned mutations after the business and data
contract is settled. Keep `integrate-supply-chain-data` primary while facts are still crossing
source, staging, schema, or reconciliation boundaries; hand off to `release-sweep` only for the
resulting exact candidate.

## Define the mutation

Before code, state:

- trigger, fresh authorization, maker-checker rule, source document/version, allowed prior state;
- idempotency key and database uniqueness boundary;
- quantity, unit, owner, warehouse, batch, quality status, amount, currency, tax, and business time;
- atomic document, ledger, balance, audit, and outbox effects;
- retry, conflict, reversal, and recovery behavior.

## Enforce the boundaries

- Stock moves only through `src/server/posting/registry.ts`; ledgers and audit logs are append-only.
  Checked by `tests/architecture/posting-single-writer.test.ts` — application writes against
  `stock_ledger`/`stock_balances` are allowed only under `src/server/posting/`. The guard resolves
  local aliases and SQL write targets and has injected positive/negative fixtures; it is not proof
  against arbitrary dynamic or interprocedural SQL. Trace those paths manually. Need a new stock
  action? Register a source in `registry.ts`; do not open a second write path.
  Being inside the posting directory is not enough: the write must be reachable through a registered source.
- Allocate document numbers through `src/server/docflow/doc-no.ts`; never use `MAX+1`.
- Use decimal strings and `src/server/core/decimal.ts`, never floating-point business arithmetic.
  Float damages the *predicate*, not just the digits: `0.1*3 - 0.3 = 5.5e-17 > 0` made a
  fully-received PO line read as "not received", opening an alert whose close condition could
  never be met (2026-09-05). Same shape in `8.7 - 8.6 - 0.1 > 0`. Any `> 0` / `<= 0` test on a
  quantity or amount must go through `dCmp`.
- Business dates come from `src/server/core/business-day.ts` only; validate user-supplied dates
  against the calendar, not just the shape — `"2026-13-45"` passes `/^\d{4}-\d{2}-\d{2}$/` and
  then explodes inside Postgres as a 500.
- Recheck identity and permissions inside the write; UI visibility is not authorization.
- Lock/update balances in deterministic `(skuId, warehouseId, batchId)` order.
- Write the business mutation and audit event in one transaction.
- Reject silent partial success; make replay return the prior result or a stable conflict.

Red-team concurrency, replay, cross-tenant access, masking, approval cycles, reversal, negative stock, rounding, and aggregation before release.
