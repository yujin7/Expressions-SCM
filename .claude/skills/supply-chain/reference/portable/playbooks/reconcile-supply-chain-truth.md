---
name: reconcile-supply-chain-truth
description: Establish the evidence-backed current state of a supply-chain project and reconcile contradictions among decision registers, specifications, code, migrations, tests, runtime behavior, and historical audits. Use when asked what is actually implemented, which source is authoritative, whether a capability is complete or production-ready, why status claims disagree, what remains unknown, or which verified gap should be addressed next.
---

# Reconcile Supply Chain Truth

Produce a dated truth packet that separates intended behavior, implemented behavior, verified behavior, and unknowns. Diagnose and report by default; do not edit specifications, code, data, or external systems unless the user explicitly requests a change.

## Frame the truth question

1. Restate the exact claim or decision being tested.
2. Record the business date, evidence as-of time, environment, branch or revision, and scope boundaries.
3. Separate these questions before gathering evidence:
   - What behavior is currently intended?
   - What behavior is implemented?
   - What behavior has been reproduced or tested?
   - What behavior is proven in production?
4. Ask only when an unresolved choice would change the scope or conclusion. Otherwise make a narrow assumption and label it.

## Bootstrap the live project

For the `供应链系统 PRD` workspace:

1. Locate the root containing `spec/CURRENT.md` and `supply-chain/package.json`.
2. Read `spec/CURRENT.md` completely as the current decision register and document router.
3. Read `supply-chain/CLAUDE.md` completely before interpreting or testing implementation.
4. Inspect the current git status and revision without disturbing unrelated changes.
5. Read only the relevant current specifications, then inspect the affected schema, migrations, rules, services, routes, jobs, UI, exports, permissions, and tests.
6. Consult historical audits and git history only for rationale or chronology. Never let a historical audit silently override a current decision.

For another project, identify the equivalent decision register, repository instructions, current specification, implementation, tests, and operational evidence.

## Match evidence to the claim

Use no universal source precedence. Select authority by question:

- Use the current decision register and current host specification for intended policy.
- Use schema, migrations, code, configuration, and deployed revision for implemented structure.
- Use reproducible tests, queries, logs, or runtime observations for verified behavior.
- Use production telemetry and dated operational records for production claims.
- Use audit reports, meeting notes, and git history for historical context.

Treat document agreement as corroboration, not execution proof. Treat code existence as capability evidence, not proof of integration, coverage, adoption, or production safety.

## Build the evidence matrix

Create one row per material claim:

| Claim | Intended | Implemented | Verified | Production evidence | Status | Confidence | Evidence / as-of | Gap or next check |
|---|---|---|---|---|---|---|---|---|

Use only these status labels:

- `Confirmed`: current intent, implementation, and relevant verification agree.
- `Partial`: a bounded subset works, but coverage or an end-to-end link is missing.
- `Planned`: current intent exists without implementation evidence.
- `Stale`: a dated claim no longer matches newer evidence.
- `Contradicted`: authoritative sources disagree materially.
- `Unknown`: evidence is absent, inaccessible, or too weak to decide.

Assign confidence from evidence quality, recency, reproducibility, and coverage. Never convert missing evidence into a negative fact or an optimistic estimate.

## Reconcile contradictions

For every conflict:

1. Quote or tightly paraphrase both claims and cite their exact locations.
2. Identify whether the conflict is a changed decision, stale documentation, incomplete implementation, configuration drift, insufficient test coverage, or environment mismatch.
3. State which conclusion is supportable for the specific question and why.
4. Preserve the losing claim as historical evidence; do not erase the conflict.
5. Name the owner and smallest verification or decision needed to close it.

If a decision changed, recommend updating `spec/CURRENT.md` and its current host specification. Do not rewrite historical audit artifacts.

## Verify proportionately

- Re-run dynamic checks when feasible; do not repeat embedded test counts or status badges as current facts.
- Trace important capabilities end to end through schema → rule or service → API, job, or integration → UI or export → permission → audit → test.
- Test high-risk claims with duplicate, retry, concurrency, partial failure, reversal, unit, precision, timezone, stale-data, and authorization counterexamples as relevant.
- Distinguish a skipped check, an inaccessible environment, a pre-existing failure, and an introduced failure.
- Never infer production readiness from local tests, demos, seeded data, or a UAT label.

## Prioritize the next truth-seeking move

Rank unresolved gaps by business consequence, irreversibility, dependency value, evidence weakness, and cost of the next check. Prefer the smallest check that can materially change the decision. Do not propose a broad rebuild when one query, focused test, or owner decision can resolve the uncertainty.

## Deliver the truth packet

Lead with the decision that is supportable now. Include only:

1. scope, revision, environment, and evidence as-of time;
2. concise conclusion with confidence;
3. the evidence matrix;
4. material contradictions and their likely cause;
5. the highest-value next checks or decisions, with owners;
6. exact checks run and important checks not run;
7. assumptions and residual unknowns.

Cite concrete file paths and line numbers or dated external evidence. Keep recommendations distinct from verified facts. Declare a capability complete only when its intended scope, implementation path, verification, and operational evidence agree.
