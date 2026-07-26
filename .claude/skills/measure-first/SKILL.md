---
name: measure-first
description: Measure and validate a performance, build-speed, test-speed, caching, bundle, query, or refactor claim before changing architecture. Use when work is motivated by slowness, scale, latency, resource use, cache behavior, or developer iteration time.
---

# Measure First

Optimize a reproducible bottleneck, not an anecdote.

Use this as the primary skill for a performance claim. Keep correctness work with its domain skill;
add `parallel-sessions` only when the measurement can interfere with shared processes, databases,
or worktrees.

1. Anchor revision, environment, data scale, cache state, command/request, and sample count.
2. Measure cold and warm behavior separately; report median, tail, failures, and relevant resources.
3. Profile the critical path and identify the dominant contributor.
4. Choose the smallest intervention with a falsifiable expected gain and rollback.
5. Repeat the same measurement after the change and test correctness at boundaries.
6. Remove the change when it is neutral, slower, or unsupported.

For iteration work, measure edit-to-signal time independently for typecheck, lint, focused tests, full tests, first route compilation, and build. Do not add worker caps, caches, rollups, queues, or service boundaries without evidence that they improve the target environment.
