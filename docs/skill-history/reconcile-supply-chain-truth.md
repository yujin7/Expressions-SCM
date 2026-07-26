---
name: reconcile-supply-chain-truth
description: Establish the evidence-backed current state of this supply-chain project. Use when specifications, status notes, code, migrations, tests, runtime behavior, or audit claims disagree; when asked whether a capability exists or is wired end to end; and before reporting a TODO, missing feature, or dead path. Diagnose and report by default. Use release-sweep to gate an exact ship candidate.
---

> **ARCHIVE ONLY** — Historical evidence, not executable guidance. Do not run commands or follow
> routing in this file; use [the quarantine index](README.md) and current `.claude/skills/`.

# Reconcile Supply-Chain Truth

Produce a dated truth packet that separates **intended**, **implemented**, **verified**, and
**deployed** behavior. Never turn missing evidence into either a defect or a success claim.

## Own one question

Rewrite the request as a falsifiable claim, for example:

- "`activateBom()` does not enforce maker-checker separation."
- "`shelfLifeDays` is parsed but never reaches the SKU master."
- "This candidate has passed the complete release gate."

Record the repository revision, worktree state, environment, business date, evidence cutoff, and
scope. If the claim changes materially while investigating, split it into separate rows.

## Orient from current evidence

1. Resolve the repository root with `git rev-parse --show-toplevel`; do not depend on a
   machine-specific absolute path.
2. Read `docs/spec/CURRENT.md` as the decision register and document router, then read
   `CLAUDE.md` as the repository operating contract.
3. Read only the relevant current specification.
4. Inspect the actual schema, migrations, rules, services, routes or jobs, UI or exports,
   permissions, audit records, and tests touched by the claim.
5. Check `git status --short -uall` and the current revision before quoting results. Preserve
   unrelated and user-authored work.
6. Use historical audits and git history for rationale or chronology, never as proof of current
   behavior.

For the repository map and evidence roles, read
[project-map.md](../../.claude/skills/supply-chain/reference/project-map.md).

## Choose the smallest evidence mode

### A. Single factual claim

Name the exact symbol, field, table, route, or behavior. Search definitions and consumers with
`rg`, then read the implementation rather than trusting comments. Reproduce the narrow behavior
when feasible. Use [single-claim.md](../../.claude/skills/supply-chain/reference/single-claim.md) for the detailed checklist.

### B. Capability reconciliation

Trace the requirement vertically:

`decision/spec → schema/migration → rule/service → API/job/integration → UI/export → permission → audit → test → runtime`

Code existence proves only that code exists. A route without a caller, a field without populated
data, or a passing unit test without the production boundary is not end-to-end evidence.

### C. Reachability or dead-plumbing audit

Trace both directions:

- upstream: who creates, parses, validates, and persists the fact;
- downstream: who reads it, under which state and data preconditions, and whether those
  preconditions occur for existing data.

Classify the result as zero consumer, parsed-not-persisted, live-but-starved, duplicate caliber,
or intentional reservation. Before deleting anything, inspect dynamic dispatch, jobs, exports,
tests, migrations, and external contracts. Use
[reachability.md](../../.claude/skills/supply-chain/reference/reachability.md) for project-specific scan patterns and dated
incident evidence.

## Match authority to the claim

There is no universal precedence across unlike questions:

| Question | Best evidence |
|---|---|
| What is the current approved intent? | Current user decision, `CURRENT.md`, and the current host specification |
| What structure or behavior is implemented? | Schema, migrations, code, configuration, and exact revision |
| What behavior is verified? | Reproducible tests, queries, logs, UI/API observations, and artifacts |
| What is deployed and operating? | Deployed revision, production telemetry, reconciliations, and dated operational records |
| Why did it change? | Decision log, git history, meeting notes, and historical audits |

When sources disagree, explain whether the cause is a changed decision, stale document, partial
implementation, configuration drift, environment mismatch, missing data, or weak verification.
Do not silently force one evidence class to answer a different question.

## Build the evidence matrix

Use one row per material claim:

| Claim | Intended | Implemented | Verified | Deployed | Status | Confidence | Evidence / as-of | Smallest next check |
|---|---|---|---|---|---|---|---|---|

Allowed statuses:

- `Confirmed` — the relevant evidence classes agree.
- `Partial` — a bounded subset works or a vertical link is missing.
- `Planned` — approved intent exists without implementation evidence.
- `Stale` — a dated claim no longer matches newer evidence.
- `Contradicted` — current sources disagree materially.
- `Unknown` — evidence is absent, inaccessible, or insufficient.

Confidence depends on recency, reproducibility, coverage, and proximity to the real boundary.
Embedded test counts and prose such as "done" are leads, not verification.

## Report without overclaiming

Lead with the answer to the falsifiable claim, then give:

1. exact evidence and revision or as-of time;
2. business or operational consequence;
3. known uncertainty and blind spots;
4. the smallest decision or check that would close the gap.

For diagnosis, remain read-only unless the user also asked for a change. For a fix, update stale
current documentation only when it is in scope; preserve historical evidence. A general truth
packet is not a release verdict—route an exact candidate to `$release-sweep`.
