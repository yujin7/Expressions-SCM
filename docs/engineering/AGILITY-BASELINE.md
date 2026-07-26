# Delivery-speed baseline

Measured on 2026-07-26 in the local macOS workspace at candidate branch `codex/agility-fast-loop-20260726`.

| Signal | Before | Candidate |
| --- | ---: | ---: |
| Application typecheck, warm | 1.88 s | 1.12–1.77 s |
| Fast architecture/rule suite | 1.46 s / 321 tests | 1.39 s / 324 tests |
| Normal fast gate | not available | about 4.5–5.2 s for a small change |
| Fast gate for this broad cleanup | not available | 11.05 s, including 192 related database tests |
| Full PR gate | manual, disconnected commands | 20.7 s / 836 passed, 21 skipped |
| Lint warnings | 106–107 | 0 |
| Production build | manual | 22.9 s, successful |
| Active project skills | 16 / 10,662 words | 7 / 1,387 words |

## Decisions supported by measurement

- Keep Vitest adaptive workers. Explicit caps of 4, 6, and 8 took about 45 s, 38 s, and 44 s; the existing default baseline was about 26 s and the current full suite completed in 14.75 s.
- Use Turbopack for ordinary development with webpack as an explicit fallback. Runtime A/B was not claimable in the managed verification environment because it rejects all local port binding with `EPERM`.
- Keep the current modular monolith. The measured inner-loop bottlenecks did not justify services, queues, rollups, or a monorepo rewrite.
- Cache and deduplicate shared remote-select reads, but do not add broad application caching without endpoint evidence.

## How to remeasure

```bash
npm run check:fast
npm run check:pr
npm run build
```

For a representative edit, record cold and warm runs separately and retain revision, data scale, cache state, command, median, and tail. Update this file only when the same scenario is repeated.
