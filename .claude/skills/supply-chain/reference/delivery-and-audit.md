# Delivery and adversarial audit playbooks

## Contents

1. PRD and product design
2. Architecture decision
3. Implementation change
4. Data migration/integration
5. UAT and rollout
6. Red-team audit
7. Severity rubric
8. Definition of done

## 1. PRD and product design

Produce:

1. Problem, baseline, target outcome, owner, and decision deadline.
2. Decision/evolution/rule ID aligned with the project registry.
3. Scope, non-goals, personas/roles, and regulatory markets.
4. Current and proposed end-to-end flow.
5. State transition table with actor, guard, effect, audit, and exception.
6. Business rules with IDs, formulas, units, rounding, examples, and counterexamples.
7. Data entities, ownership, source, grain, effective dates, and retention.
8. Permissions, maker-checker, sensitive fields, and evidence.
9. Integration contracts, freshness, reconciliation, retries, and fallbacks.
10. Happy, partial, exception, correction, and recovery scenarios.
11. Measurable acceptance criteria, KPIs, telemetry, rollout, and rollback.
12. Open decisions with options, recommendation, owner, and due date.

Do not use “support,” “intelligent,” “real time,” “accurate,” or “complete” without a measurable definition.

## 2. Architecture decision

Document:

- context and forces;
- decision and boundaries;
- alternatives and why rejected;
- data ownership and consistency model;
- transaction, idempotency, ordering, and failure semantics;
- security/privacy/compliance controls;
- NFR budget and capacity assumptions;
- migration, compatibility, rollback, and exit strategy;
- observability and operational ownership;
- tests or spikes that falsify the riskiest assumptions.

Prefer a decision table when comparing options. Mark assumptions separately from evidence.

## 3. Implementation change

Trace the requested behavior through:

1. authoritative requirement/decision;
2. schema/enums/constraints/indexes;
3. migration and backfill;
4. pure rule and counterexamples;
5. transactional service/posting/approval;
6. API validation, authorization, errors, and idempotency;
7. UI states, reasons, accessibility, and permission handling;
8. jobs/integrations/notifications;
9. audit/lineage/metrics;
10. targeted, integration, security, and regression tests;
11. docs/UAT/operations where behavior changed.

Before editing, inspect the full affected path. After editing, run focused checks first and broader checks proportional to blast radius.

Never “fix” unrelated dirty files. Report pre-existing changes and failures distinctly.

## 4. Data migration/integration

Require:

- immutable source artifact/payload, hash, owner, and as-of;
- parser version and row-count/control-total expectations;
- raw/staging/validated/released/rejected/superseded states;
- field mapping, units, dates, enums, null semantics, and identity resolution;
- duplicate and collision policy;
- validation severity and review ownership;
- approval/release boundary;
- idempotent replay and rollback/supersession;
- source-to-target reconciliation by counts, quantities, and amounts;
- lineage from target row to source row and transformation;
- cutover, coexistence, freeze, and recovery plan.

Test malformed files, partial uploads, duplicate replays, changed files with the same name, mixed time zones, ambiguous aliases, invalid units, missing masters, and interruption after commit.

## 5. UAT and rollout

Build scenarios by role and risk, not page count:

- normal end-to-end flow;
- every approval rejection/resubmission cycle;
- partial/late/over/short/duplicate actions;
- quality failure/concession/return/rework/scrap;
- cancellation and linked reversal after posting;
- stale or incomplete external data;
- permission and sensitive-field attempts through API/export;
- retry/concurrency/integration outage;
- reconciliation and month-end/close;
- recall trace and mock-recall quantity reconciliation.

For each scenario record:

- preconditions and fixture IDs;
- actor and permission;
- steps and expected state/facts;
- expected ledger/audit/integration effects;
- measurable pass condition;
- evidence and defect link;
- cleanup or reversal.

Define entry/exit gates, severity thresholds, parallel-run duration, daily reconciliation, signing roles, stop criteria, rollback steps, and post-launch monitoring.

## 6. Red-team audit

Run independent lenses where practical:

- domain/accounting correctness;
- quality/regulatory/traceability;
- data model, migration, and lineage;
- state machine, concurrency, retries, and posting;
- security, authorization, privacy, and export;
- planning/model evaluation and automation safety;
- usability, role workload, and exception recovery;
- requirements traceability, acceptance, and operations.

For each suspected finding:

1. Reproduce or prove it from primary artifacts.
2. Identify the exact invariant or requirement violated.
3. Give a minimal counterexample with quantities/states when possible.
4. State impact, reachability, and affected roles/data.
5. Distinguish confirmed defect, design gap, stale document, and hypothesis.
6. Recommend the smallest robust repair and the regression test.
7. Re-check that the repair does not violate another invariant.

Audit “implemented” claims vertically. A PRD row, schema column, route, page, or unit test alone is not an end-to-end capability.

Do not inflate finding counts. Explicitly record high-risk hypotheses that were tested and disproved when that evidence changes confidence.

## 7. Severity rubric

| Severity | Meaning | Examples |
|---|---|---|
| S0 / Blocker | Cannot safely build, migrate, approve, or go live | no authoritative grain/formula; unrecoverable corruption path; missing legal release gate |
| S1 / Critical | Reachable material loss, compliance, security, or irreconcilable state | double posting; cross-material settlement; unauthorized cost export; recalled lot shippable |
| S2 / Major | Core workflow or decision materially wrong with workaround/limited scope | stale snapshot drives duplicate buy; partial receipt cannot close; KPI denominator wrong |
| S3 / Minor | Localized correctness, clarity, usability, or maintainability defect | misleading label; missing empty state; noncritical audit detail |

Assign severity from evidence, likelihood, blast radius, detectability, and recoverability—not rhetorical intensity.

## 8. Definition of done

Confirm all applicable statements:

- The decision owner, scope, baseline, target, and non-goals are explicit.
- The current source hierarchy has no silent conflict.
- State, quantities, units, time, quality, lot, and cost semantics are defined.
- Happy, partial, correction, return, cancellation, and recovery paths close.
- Inventory, audit, and source evidence remain replayable and reconcilable.
- Permissions and maker-checker rules hold at service/API/export boundaries.
- Integrations and jobs are idempotent, observable, replayable, and reconcilable.
- Forecast/AI behavior has a baseline, temporal evaluation, uncertainty, human boundary, and outcome logging.
- Migration/cutover/rollback and operational ownership are executable.
- Acceptance tests include counterexamples and affected roles.
- Relevant tests, type checks, builds, migrations, and visual/flow checks pass.
- Documentation, code, tests, and UAT describe the same behavior.

If one statement is intentionally deferred, name the risk, owner, containment, and due date.
