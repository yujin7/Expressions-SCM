---
name: design-supply-chain-flows
description: Design an end-to-end cosmetics supply-chain business flow and its minimal product and technical contract. Use when the user asks for a PRD, workflow, state machine, domain model, acceptance criteria, or design artifact, or when a new or changed workflow contract is unresolved. Do not activate solely because a bounded implementation request is new; do not use for as-is audits or release approval.
---

> **ARCHIVE ONLY** — Historical evidence, not executable guidance. Do not run commands or follow
> routing in this file; use [the quarantine index](README.md) and current `.claude/skills/`.

# Design Supply Chain Flows

Turn business intent into an implementable operating contract before designing screens or writing code.

## Own one question

Answer: **What should this workflow do, who may decide, and which facts change?**

- Use the current integration/truth skill when the question is what already exists.
- Use `$write-path` to implement a transactional mutation through project invariants.
- Use `$release-sweep` to gate a concrete candidate.
- Make changes only when the user asks to build or implement; otherwise produce the design.

## Orient from evidence

1. Resolve the repository root with `git rev-parse --show-toplevel` and identify the affected capability.
2. In this repository, read `docs/spec/CURRENT.md` completely and then `CLAUDE.md` completely.
   Do not depend on a machine-specific absolute path.
3. Read the project map in
   [project-map.md](../../.claude/skills/supply-chain/reference/project-map.md) when document roles are unclear.
4. Read the smallest relevant specifications and inspect the actual schema, rules, services, routes, jobs, UI, exports, permissions, and tests.
5. Preserve user-authored and unrelated work.
6. Reconcile requested intent with current constraints. Label observed fact, approved decision, assumption, proposal, and open question distinctly.

Ask only when a missing choice changes financial correctness, product safety, legal exposure, scope, or an irreversible decision. Otherwise choose the narrowest reversible assumption and state it.

## Frame the operating decision

Define:

- outcome, baseline, target, and accountable owner;
- actor, trigger, preconditions, approval authority, and separation of duties;
- product, formula or BOM version, market, legal entity, channel, warehouse, supplier, owner, quality status, and time horizon in scope;
- source of truth, business date, freshness, coverage, and latency for every decision input;
- explicit non-goals and policy choices that must remain configurable.

Do not turn a page request into a page specification until the operating decision is coherent.

## Model facts before states

Classify each datum as one of:

- governed master or version data;
- workflow document or approval;
- immutable movement, event, or audit evidence;
- external reference or point-in-time snapshot;
- derived metric or forecast;
- recommendation, simulation, or human decision.

Assign each fact a system of record, owner, identifier, lifecycle, retention rule, and correction method. Keep unknown, missing, stale, estimated, and zero distinct. Model quantity, unit, location, owner, lot or batch, expiry, quality disposition, cost, currency, tax, and business time explicitly when relevant.

Never design reference snapshots as transactional stock or recommendations as approved decisions.

## Specify the complete flow

1. Write the happy path in business language.
2. Add partial, late, duplicate, concurrent, rejected, cancelled, returned, corrected, timed-out, and recovery paths.
3. Define states and legal transitions. For each transition specify:
   - initiating role and approving role;
   - preconditions and deterministic guards;
   - authoritative inputs and freshness limits;
   - atomic effects on documents, movements, reservations, costs, quality, and audit;
   - idempotency key and uniqueness boundary;
   - notification or integration events;
   - compensating or linked reversal path.
4. Define maker-checker boundaries and revalidate state and payload at commit time.
5. Snapshot approved calculation inputs needed to reproduce later outcomes.
6. Make irreversible choices, manual overrides, and escalation rules visible.

For cosmetics flows, include formula/BOM and market versions, supplier or site, lot genealogy, QC disposition, manufacture and expiry dates, FEFO eligibility, channel restrictions, and recall reach where relevant.

## Trace the vertical contract

Map every requirement through:

`schema → pure rule/service → API/job/integration → UI/export → permission → audit → test → operational procedure`

For each layer, specify only what must change:

- entity, key, constraint, precision, and migration;
- deterministic policy versus configurable threshold;
- request, response, error, concurrency, and idempotency contract;
- UI action, explanation, exception queue, stale state, and recovery;
- role, scope, masking, and export parity;
- audit evidence and operational metric;
- acceptance and counterexample tests.

Prefer the existing modular monolith and shared project calibers. Add a new service, event, model, or platform only when a measured boundary requires it.

## Bound automation wisely

- Use deterministic rules for eligibility, units, posting, settlement, approvals, and hard stops.
- Use statistical or optimization models for uncertain future decisions.
- Use LLMs for unstructured extraction, explanation, classification assistance, and drafting.
- Keep approval, posting, quality release, payment, regulated-data changes, and recall activation behind named human authority.
- Define abstention, fallback, explanation, monitoring, and rollback before increasing autonomy.

## Verify the design

Walk at least one concrete example and the highest-risk counterexamples end to end. Confirm conservation of quantity and money, unit compatibility, authorization, traceability, replayability, and recovery.

Write acceptance criteria as observable behavior, including:

- success;
- validation rejection with no side effects;
- repeated and concurrent request;
- stale approval or changed state;
- partial and compensation path;
- permission and masking;
- audit and reconciliation evidence.

## Deliver a decision-ready specification

Produce:

1. decision summary and scope;
2. actors, facts, sources, and assumptions;
3. state transition and effects table;
4. exception and recovery paths;
5. vertical impact matrix;
6. acceptance and counterexample criteria;
7. metrics, rollout dependencies, and unresolved decisions.

Keep prose lean. Prefer explicit tables and examples where they remove ambiguity.
