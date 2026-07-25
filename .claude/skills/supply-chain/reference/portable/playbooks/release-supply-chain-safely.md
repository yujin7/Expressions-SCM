---
name: release-supply-chain-safely
description: Red-team and gate a supply-chain change or release using risk-based verification across business rules, migrations, permissions, exports, security, concurrency, integration replay, observability, rollback, UAT, and go-live evidence. Use for “is this safe to ship?”, regression reviews, launch gates, and production-readiness decisions. Do not use merely to summarize what currently exists.
---

# Release Supply Chain Safely

Make a defensible ship decision from current evidence. Treat this as release assurance, not deployment authority.

## Own one decision

Answer: **Is this exact candidate safe enough to release under the stated rollout and rollback plan?**

- Use `$reconcile-supply-chain-truth` for general as-is status or disputed project claims.
- Use the relevant domain skill to design or repair a flow.
- Review only when asked to assess. Implement fixes only when the user also asks to change or build.
- Never deploy, migrate production data, approve UAT, or accept business risk on someone else's behalf without explicit authority.

## Anchor the candidate

1. Identify the repository, branch or commit, environment, intended release contents, excluded changes, and business date.
2. In this project, locate the root containing `spec/CURRENT.md` and `supply-chain/package.json`.
3. Read `spec/CURRENT.md` completely, then `supply-chain/CLAUDE.md` completely.
4. Inspect the actual diff, schema, migrations, rules, services, routes, jobs, UI, exports, permissions, tests, and operational instructions touched by the candidate.
5. Check the live worktree before acting. Preserve unrelated and user-authored changes.
6. Treat status documents and prior test counts as leads, never as proof of the candidate.
7. State evidence freshness and environment. Mark unavailable runtime evidence as unknown, not passed.

Stop and report an unbounded gate if the candidate, environment, or acceptance authority cannot be identified.

## Build a risk-led verification matrix

Trace each changed capability through the layers it can affect:

`schema/migration → rule/service → API/job/integration → UI/export → permission → audit → test → operation`

Cover only applicable lenses, but never skip one silently:

- **Business behavior:** state transitions, partial/late/cancel/return/correction paths, approvals, and acceptance criteria.
- **Transactional integrity:** decimals, units, ownership, posting, idempotency, concurrency, linked reversals, and append-only history.
- **Data change:** forward migration, backfill, validation, compatibility, retry safety, reconciliation, and restoration strategy.
- **Authorization and privacy:** role boundaries, maker-checker, tenant/legal-entity scope, field masking, downloads, logs, and error payloads.
- **Integration:** contract compatibility, source identity, duplicate and out-of-order delivery, replay, dead letters, outbox delivery, and reconciliation.
- **User experience:** loading, empty, stale, partial, permission-denied, validation, recovery, target viewport, and export parity.
- **Operations:** health, metrics, logs, alerts, runbook, support ownership, feature flag or canary, capacity, and incident response.
- **Rollback:** reversible application change, compatible database state, queued events, data repair, decision owner, and abort thresholds.

Rank risks by consequence, likelihood, detectability, and recovery difficulty. Spend verification effort on irreversible facts and silent failures first.

## Execute the smallest sufficient evidence loop

1. Convert every release-critical claim into an observable check with an expected result.
2. Reuse repository-prescribed commands and fixtures. Do not invent a passing proxy for a required check.
3. Run narrow tests first, then the relevant regression suite, build, migration checks, and health checks.
4. Inspect or exercise the real UI and export path when user-visible behavior changed.
5. Test at least the highest-risk counterexamples:
   - repeated, concurrent, and out-of-order requests;
   - stale approval or state change between preview and commit;
   - partial success, timeout, retry, and recovery;
   - wrong unit, tenant, warehouse, owner, lot, quality status, or permission;
   - masked data exposed through an alternate route, export, log, or error;
   - rollback after data or event side effects.
6. Record the exact command, environment, result, and artifact for each check.
7. When a check fails, distinguish product defect, test defect, environment defect, and missing evidence. Fix only in scope, then rerun the failed check and the affected regression boundary.

Do not convert “not run,” flaky, stale, or unavailable into “pass.”

## Apply release judgment

Classify findings by operational consequence:

- **Blocker:** credible risk of incorrect stock or money, unsafe product release, broken traceability, unauthorized access, unrecoverable migration, data loss, or no viable rollback.
- **High:** material workflow or integration failure with no safe containment.
- **Medium:** contained defect with a practical workaround and monitored recovery.
- **Low:** limited impact that can be deferred without obscuring a critical signal.

Return one verdict:

- **READY:** all release-critical evidence passed and residual risks have named controls.
- **READY WITH EXPLICIT ACCEPTANCE:** no blocker remains, but a named accountable owner must accept bounded residual risk.
- **NOT READY:** a blocker, failed critical check, or unsafe rollback remains.
- **UNKNOWN:** evidence required for a responsible decision is unavailable.

Never average away a blocker with a good aggregate score.

## Produce a compact release dossier

Report:

1. candidate, environment, scope, and evidence as-of time;
2. verdict and the shortest defensible rationale;
3. release-critical matrix with pass, fail, unknown, or not applicable;
4. findings ordered by severity with file, behavior, and consequence evidence;
5. migration, rollout, monitoring, abort, and rollback conditions;
6. residual risks, accountable acceptors, and expiry date for temporary controls;
7. exact next actions required to move the verdict.

Lead with the verdict. Separate observed facts, inferences, and recommendations.
