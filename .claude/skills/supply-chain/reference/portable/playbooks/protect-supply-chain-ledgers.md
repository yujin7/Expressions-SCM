---
name: protect-supply-chain-ledgers
description: Design, implement, review, or debug transaction-critical supply-chain flows. Use when work touches inventory posting, document approval, quantity or cost arithmetic, unit conversion, settlement, reversals, concurrency, idempotency, immutable audit, or reconciliation.
---

# Protect Supply Chain Ledgers

Keep authorized operational facts correct, replayable, and explainable under retries, concurrency, partial failure, and correction. Prefer a small transactional boundary with explicit invariants over distributed cleverness.

## Start from live evidence

1. Locate the project root. Prefer the current workspace when it contains `spec/CURRENT.md` and `supply-chain/package.json`; otherwise inspect `/Users/yj/Downloads/供应链系统 PRD` if present.
2. Read `spec/CURRENT.md` and `supply-chain/CLAUDE.md` completely.
3. Read the current specification for the affected flow, then trace the actual schema, migrations, pure rules, services, routes or jobs, UI and exports, authorization, audit records, and tests.
4. Inspect the worktree before editing and preserve unrelated changes.
5. Separate intended behavior from implemented behavior. Treat documents as claims until code, constraints, and tests support them.
6. For reviews or diagnosis, remain read-only unless the user also asks for a change.

## Fix ownership before behavior

Assign one authoritative writer to each invariant:

- A workflow service owns draft, submit, approve, reject, cancel, and close transitions.
- The central posting engine alone owns inventory movements and derived on-hand state. Never let a route, import, report, or approval handler update stock directly.
- Append-only ledgers own posted facts. Correct them with linked reversals or compensating entries; never delete history or restore an approved document to an editable state.
- Snapshots own the approved BOM, price, loss, tax, conversion, and other inputs required to replay a decision.
- The audit log owns who did what, when, from which prior state, and why.
- Integration staging owns received external claims, not accepted domain facts.
- Reports and forecasts derive facts; they never repair transactional state.

Stop and surface a design conflict when two components can write the same invariant.

## Build the transaction contract

Before changing code, write the smallest useful contract:

- business trigger and authorized actor;
- preconditions and fresh authorization checked at write time;
- source document, version, and immutable idempotency key;
- state transition with allowed prior states;
- quantity, unit, owner, location, status, lot or batch, expiry, quality disposition, cost, currency, tax, and business time where relevant;
- movement lines and their sign convention;
- atomic records written together;
- downstream events written through an outbox;
- reversal or compensating path;
- reconciliation rule and observable failure signal.

Express effects as `guard → state change → movement/audit/outbox records → invariant`. Reject any effect that cannot be replayed from persisted inputs.

## Preserve non-negotiable invariants

- Use decimal-safe types and calculations for money and quantity; never rely on binary floating point.
- Normalize through versioned conversions but retain original quantity and unit. Never sum incompatible units or settle one material against another.
- Allocate document numbers through a concurrency-safe counter such as `doc_counter`, never `MAX+1`.
- Enforce idempotency and uniqueness in the database, not only in application memory.
- Assume at-least-once delivery. Make retries return the first committed result without duplicating effects.
- Keep approval separation, current-state guards, and authorization inside the transaction boundary where possible.
- Distinguish planning loss, execution variance, quality disposition, and financial deduction.
- Represent unknown, missing, stale, estimated, and zero as different states.
- Do not post held, rejected, expired, recalled, or otherwise ineligible stock.
- Commit domain state, ledger movements, audit evidence, and outbox intent atomically, or make the incomplete state detectable and recoverable.

## Implement the narrow vertical slice

1. Put deterministic eligibility and arithmetic in pure rules with explicit inputs and outputs.
2. Put locking, conditional transitions, uniqueness, posting, audit, and outbox writes in one application transaction.
3. Keep route and UI code thin; they request the operation and present its result.
4. Return stable reason codes for rejection, conflict, duplicate, and retry outcomes.
5. Reuse the project's canonical posting, stock-view, unit, permission, and masking boundaries.
6. Add a migration for database guarantees and verify fresh and upgraded databases.
7. Add only the observability needed to detect duplicate suppression, posting failure, imbalance, reconciliation drift, and stuck outbox work.

Do not split services or add a queue unless an actual ownership, scaling, or failure-isolation requirement demands it.

## Attack counterexamples before declaring done

Test the happy path plus the smallest high-value adversarial set:

- the same request twice, including after a client timeout;
- two actors approving or posting concurrently;
- a retry after the transaction commits but before the response arrives;
- failure between document transition, ledger write, audit write, and event publication;
- stale document state or stale authorization;
- zero, negative, fractional, oversized, and high-precision quantities;
- incompatible or changed unit conversions;
- insufficient, held, expired, recalled, wrong-owner, wrong-location, or wrong-lot stock;
- partial receipt, over/under delivery, short close, cancellation, return, and substitution;
- reversal twice, reversal of the wrong version, and correction after downstream consumption;
- timezone and business-date boundaries;
- unauthorized API, field, list, detail, and export access.

Prefer invariant assertions and database-level concurrency tests over snapshots of incidental UI text. Verify that reversal plus original nets to zero where policy requires it, while both facts and their lineage remain visible.

## Respect authority boundaries

Read, analyze, draft, implement, and test within the authorized workspace. Never use this skill to approve a real document, post live inventory, release a quality hold, make a payment, delete ledger history, or conceal a reconciliation difference. At any consequential write gate, re-read current state, actor authority, target, payload, and idempotency key.

## Deliver a lean result

Lead with the invariant verdict. Include only:

- evidence and any conflict between specification and implementation;
- the transaction contract and authoritative owner;
- changed vertical slice or recommended change;
- counterexamples and exact checks run;
- residual risk, rollback or compensating path, and unresolved decision owner.

Do not declare completion until state, ledger, audit, authorization, retry behavior, and reconciliation agree.
