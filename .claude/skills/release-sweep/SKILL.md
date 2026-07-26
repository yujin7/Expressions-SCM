---
name: release-sweep
description: Gate an exact branch, commit, or release candidate with full-story verification and adversarial review. Use before declaring broad work complete or shippable, after consequential mutations or migrations, and when runtime behavior may diverge from static tests.
---

# Release Sweep

Return a verdict for one anchored candidate and environment: `READY` only when every required
check passes; otherwise `NOT READY`. Document authorized risk acceptance separately—it cannot turn
skipped live or database evidence into readiness.

This is the terminal verification primary, not an implementation companion. Activate it only after
the implementation skill has produced an exact candidate; add `parallel-sessions` only while
shared state makes the evidence unstable.

## Anchor and verify

1. Record commit, branch, dirty paths, target environment, migration/config version, evidence cutoff, rollout, and rollback.
2. Run `npm run check:release`; use `SCM_VERIFY_LIVE=1` only when a live target is intentionally available.
3. Verify representative browser → API → service → database → response stories, including hydration and permissions.
4. Check health, migration drift, jobs, imports/exports, empty/error states, and rollback evidence.
5. Red-team concurrency, replay, idempotency, authorization, masking, reversal, precision, negative stock, and cross-entity aggregation.
6. Separate proven results, accepted risk, unavailable evidence, and blockers.

Never convert a skipped live check, unavailable database, or passing unit suite into runtime proof. Do not deploy, migrate production, or accept business risk without explicit authority.
