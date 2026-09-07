---
name: supply-chain
description: Orchestrate system-level work in this cosmetics supply-chain repository when a request crosses three or more of workflow design, transactions, integrations, planning, quality, architecture, and release. Use for roadmaps, architectural trade-offs, capability sequencing, or ambiguous end-to-end initiatives. Use a narrower skill for bounded work.
---

# Supply Chain Architect

Own the business outcome, system boundaries, and sequencing. Do not load every specialist by default.

## Route first

1. Read `CLAUDE.md` and `docs/NOW.md` when present.
   Read `docs/spec/CURRENT.md` when current intent, scope, or a business ruling matters.
2. State the outcome, accountable role, affected facts, irreversible choices, and acceptance evidence.
3. Select exactly one primary skill for the current phase:
   - workflow, UX, planning, quality, and alerts: `design-supply-chain-flows`
   - external data, schema evolution, reconciliation: `integrate-supply-chain-data`
   - mutations, posting, approvals, audit: `write-path`
   - performance claims: `measure-first`
   - candidate readiness and adversarial verification: `release-sweep`
4. Add `parallel-sessions` as the minimum safety constraint only when concurrent Git, process,
   database, or evidence state requires it; it never becomes a second domain primary.
5. When the phase changes, hand off sequentially to the new primary. In particular, use
   `release-sweep` only after an exact candidate exists.
6. Keep recommendations explainable, reversible, and proportional to present scale.

For a broad improvement goal, keep an explicit task-to-evidence map and select the next slice by
user impact and dependencies. Log incidental findings without letting low-impact cleanup replace
the requested experience. Inspect existing skills/components/tools before adding another layer;
compare a credible alternative and the cost of keeping it, not just the cost of building it.

## Non-negotiable judgment

- Separate observed fact, approved decision, assumption, proposal, and open question.
- Prefer evolution and vertical slices over rewrites or new platforms.
- Never treat missing, stale, uncovered, quarantined, or unknown data as zero or available.
- Automated recommendations must expose evidence time, coverage, uncertainty, abstention, and human authority.
- Stock, money, quality release, and identity changes require explicit invariants and evidence.

## Reference router

- repository map and evidence roles: [project-map.md](reference/project-map.md)
- business rules and decisions: [domain-rules.md](reference/domain-rules.md)
- transactional invariants: [invariants.md](reference/invariants.md)
- decision-quality and industry context: [excellence.md](reference/excellence.md)
- cosmetics planning and quality constraints: [cosmetics-domain.md](reference/cosmetics-domain.md)
- architecture, integration, security, and AI governance: [architecture-and-ai.md](reference/architecture-and-ai.md)
- delivery and audit checklists: [delivery-and-audit.md](reference/delivery-and-audit.md)
- dated primary-source index: [authoritative-sources.md](reference/authoritative-sources.md)
- one falsifiable truth claim: [single-claim.md](reference/single-claim.md)
- writer-to-reader reachability: [reachability.md](reference/reachability.md)

Load only the references the current question needs. `docs/skill-history/` is a quarantined,
non-executable archive and never a workflow source.
