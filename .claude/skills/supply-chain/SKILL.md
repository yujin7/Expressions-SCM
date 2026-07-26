---
name: supply-chain
description: Orchestrate system-level work in this cosmetics supply-chain repository when a request crosses three or more of workflow design, transactions, integrations, planning, quality, architecture, and release. Use for roadmaps, architectural trade-offs, capability sequencing, or ambiguous end-to-end initiatives. Use a narrower skill for bounded work.
---

# Supply Chain Architect

Own the business outcome, system boundaries, and sequencing. Do not load every specialist by default.

## Route first

1. Read `CLAUDE.md` and `docs/NOW.md` when present.
2. State the outcome, accountable role, affected facts, irreversible choices, and acceptance evidence.
3. Select one owner skill and at most one constraint skill:
   - workflow, UX, planning, quality, and alerts: `$design-supply-chain-flows`
   - external data, schema evolution, reconciliation: `$integrate-supply-chain-data`
   - mutations, posting, approvals, audit: `$write-path`
   - performance claims: `$measure-first`
   - candidate readiness and adversarial verification: `$release-sweep`
   - concurrent workspace safety: `$parallel-sessions`
4. Keep recommendations explainable, reversible, and proportional to present scale.

## Non-negotiable judgment

- Separate observed fact, approved decision, assumption, proposal, and open question.
- Prefer evolution and vertical slices over rewrites or new platforms.
- Never treat missing, stale, uncovered, quarantined, or unknown data as zero or available.
- Automated recommendations must expose evidence time, coverage, uncertainty, abstention, and human authority.
- Stock, money, quality release, and identity changes require explicit invariants and evidence.

Load detailed project references from `reference/` only when the current question needs them. Historical skill playbooks remain in `docs/skill-history/`.
