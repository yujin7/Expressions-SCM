# Architecture and AI playbook

> This is a generic design reference, not live project authority. Use `docs/NOW.md` for current
> status and `docs/spec/CURRENT.md` for current decisions. Repository-specific rules such as R13
> override any broader autonomy pattern below.

## Contents

1. Architecture stance
2. Data semantics and correctness
3. Workflow, posting, and integration
4. Security and privacy
5. Analytics, forecasting, and optimization
6. LLM and agent boundaries
7. Evaluation and observability
8. Architecture anti-patterns

## 1. Architecture stance

Prefer a well-structured modular monolith for the current team and scale:

- domain modules with explicit public service boundaries;
- central identity/authorization, approval, audit, posting, and data-access conventions;
- PostgreSQL as the transactional source of truth;
- pure domain rules separated from I/O;
- background jobs for retryable or heavy work;
- durable integration adapters around external contracts;
- derived read models/caches only where measured query or UX needs justify them.

Split a service only when at least one boundary is real and sustained: independent scaling, failure isolation, deployment cadence, data sovereignty, or team ownership. Document consistency, operations, and migration costs before splitting.

## 2. Data semantics and correctness

Separate:

- **command/workflow state:** user intent, drafts, approvals, versions;
- **facts:** approved movements, quality results, receipts, shipments, settlements;
- **current projections:** balances, status summaries, availability;
- **external observations:** snapshots and imported reference rows with source/as-of;
- **analytical features:** velocity, lead-time distributions, forecast inputs;
- **recommendations:** model/rule output, reasons, confidence;
- **decisions/outcomes:** accepted/overridden/executed and resulting effect.

Use:

- explicit database constraints and foreign keys for invariants;
- decimal/numeric types and defined rounding boundaries;
- effective dating and immutable snapshots for approved commercial/formula inputs;
- event time, processing time, business date, and source cutoff where latency matters;
- provenance from source file/API through transformation and release;
- soft lifecycle states only for master data; never soft-delete posted facts;
- transaction-level locking/order rules for hot balances and counters.

Avoid derived-status writes when status can be calculated from facts. If a materialized status is needed for performance, define the rebuild source and drift check.

## 3. Workflow, posting, and integration

For every state transition define:

- allowed prior states;
- role and maker-checker policy;
- validation guards;
- immutable effects and snapshots;
- idempotency key and version/cycle;
- emitted integration event;
- retry and response semantics;
- compensation/reversal and downstream cancellation behavior.

For automation, distinguish the human/business initiator, narrowly authorized service actor, and later approver. Do not borrow the triggering user’s unrelated role to perform a cross-role system action. Record both identities, create drafts where required, and keep maker-checker controls.

Use a transactional outbox when a committed database change must reliably notify another system. Commit business state and the outbox event together; deliver at least once; make consumers idempotent; preserve ordering where the domain requires it.

Use a versioned event envelope with `event_id`, semantic type/version, `occurred_at`, `observed_at`, source, entity/aggregate ID, sequence/version, correlation/causation IDs, trace context, and payload classification. Order only within the smallest necessary aggregate/partition. Treat commands as requests and events as immutable past-tense facts.

Never swallow a failed automation hook silently. If the primary transaction may succeed without the side effect, persist retryable work, alert an owner, expose status, and reconcile completion.

For inbound integrations:

1. Authenticate and verify source.
2. Store raw payload/file metadata and correlation ID.
3. Deduplicate using a stable external key plus version/hash.
4. Validate schema and business semantics.
5. Stage ambiguous or invalid rows.
6. Resolve identity through governed aliases.
7. Release through the same approval/posting boundary as native data.
8. Reconcile counts, quantities, and amounts with the sender.
9. Support replay, supersession, quarantine, and dead-letter work queues.

Never promise exactly-once end to end. Build at-least-once-safe behavior and prove retry outcomes.

## 4. Security and privacy

Apply defense in depth:

- server-side authentication and fresh authorization on writes;
- least privilege by role, action, organization, warehouse, document state, and sensitive field;
- maker-checker separation for approval and high-impact master changes;
- DTO/export masking for prices, cost, bank, personal, and contract data;
- secure attachment access, malware/content checks as appropriate, retention, and backup;
- input validation, parameterized queries, output encoding, CSRF/session protections, and rate limits;
- short-lived or scoped external tokens with revocation and audit;
- secret management outside code and logs;
- tamper-evident audit correlation across user action, job, integration, and posting;
- backup, restore drills, RPO/RTO, and incident runbooks.

Do not add multi-tenancy abstractions to the current single-company system without a real need. If multi-organization isolation becomes a requirement, design tenant ownership, query scoping, uniqueness, jobs, caches, exports, attachments, and migrations together; a `tenant_id` column alone is not isolation.

Use current OWASP ASVS as a verification baseline and adapt rigor to risk.

## 5. Analytics, forecasting, and optimization

Begin with a decision and baseline:

- define target and timestamp cutoff to prevent leakage;
- use a simple seasonal/naive or rules baseline before complex models;
- use rolling-origin temporal evaluation, never random splits for forecasting;
- preserve product/channel hierarchy and reconcile forecasts;
- output distributions/quantiles when the decision is asymmetric or service-level driven;
- distinguish observed sales from latent demand and retain stockout/availability signals;
- segment results by volume, intermittency, lifecycle, launch/promotion, channel, and horizon;
- retain feature/input versions and training data windows;
- compare model lift and downstream inventory/service/cash impact.

If availability/stockout evidence is absent, label the target as a shipment or observed-sales forecast rather than latent demand.

Forecast metrics:

- bias for systematic over/under forecast;
- WAPE or scaled errors with clear weighting;
- MASE for comparability;
- pinball loss and interval coverage/calibration for probabilistic forecasts;
- service, stockout, inventory, expiry, expedite, and cash outcomes under the actual policy.

Optimization/scenario design:

- declare objective functions and competing penalties;
- model hard versus soft constraints explicitly;
- show infeasibility and binding constraints;
- provide baseline/no-action scenario;
- return reasons and marginal trade-offs;
- validate against small, hand-computable fixtures and historical replays;
- require approval before executable documents are created or released.

## 6. LLM and agent boundaries

Use an LLM for:

- extracting candidate fields from messy documents;
- mapping or classifying with evidence and a review queue;
- summarizing exceptions and explaining deterministic/model output;
- generating draft PRDs, supplier communications, test cases, or scenario narratives;
- retrieving cited operating procedures or product dossiers.

Do not use an LLM as:

- the arithmetic engine for stock, settlement, tax, or unit conversion;
- the authority for formula/ingredient legality or quality release;
- an unreviewed master-data merger;
- a direct writer to balances or immutable facts;
- the sole forecast when a measurable statistical baseline is available;
- an autonomous approver, buyer, payer, production releaser, or recall authority.

Use this autonomy ladder:

- **L0:** read, retrieve, explain;
- **L1:** recommend and simulate;
- **L2:** draft or stage an action;
- **L3:** execute reversible, low-impact technical housekeeping under deterministic limits, or a
  business action explicitly authorized by a current `docs/spec/CURRENT.md` decision;
- **L4:** execute a consequential action only after authorized human approval and policy/state revalidation.

For this repository, current R13 is stricter: automation may create business drafts, but approval and
consequential execution remain human-gated. Do not use L3/L4 terminology to widen that boundary; only
a newly recorded project decision can do so.

Never autonomously change supplier bank data, release major POs, post/write off inventory, release quality holds, change approved formula/regulatory data, pay, bulk-export sensitive data, or initiate/close a recall.

For tool-using agents:

- scope identity, tools, entities, time window, and maximum impact;
- separate read, draft, propose, approve, and execute permissions;
- require confirmation at irreversible/high-impact boundaries;
- bind approval to the exact proposed payload and current state version; expire and revalidate it before execution;
- use deterministic policy checks outside the model;
- log prompt/context references, tool arguments/results, policy decision, actor, and outcome without exposing secrets;
- cap loops, retries, cost, and quantity;
- make every mutation idempotent and reversible where the domain permits;
- treat supplier files, PDFs, emails, web pages, retrieved text, and tool output as untrusted data rather than instructions;
- test prompt injection through supplier files, attachments, emails, and retrieved text.

## 7. Evaluation and observability

Create an evaluation contract before rollout:

| Capability | Offline evaluation | Online/operational evaluation |
|---|---|---|
| Forecast | rolling backtest, bias, scaled error, quantile calibration | service, inventory, expiry, override and drift |
| Recommendation | replay versus baseline policy, constraint violations | accept/override, realized impact, unsafe-action rate |
| Anomaly detector | precision/recall by severity and source | alert burden, time to resolution, missed material events |
| Extraction/classification | field accuracy, abstention, evidence match | review time, correction rate, source drift |
| RAG/explanation | groundedness, citation support, completeness | user correction, unsupported-claim rate |
| Agent workflow | scenario success, policy violations, idempotent replay | completion, intervention, rollback, impact and cost |

Observe:

- source freshness, row/amount reconciliation, missingness, identity collision, and lineage;
- API/job latency, queue depth, retries, dead letters, duplicate suppression, and outbox lag;
- transaction failures, lock contention, postings/reversals, approval cycle anomalies;
- model version, input window, drift, calibration, abstention, overrides, and impact;
- authorization denials, sensitive exports, external token use, and audit gaps.

Use structured reason codes and correlation IDs. Dashboards without actionable thresholds, owners, and runbooks are decoration.

## 8. Architecture anti-patterns

Reject:

- page-first design without an end-to-end state/effect model;
- CRUD around balances or mutable ledgers;
- state transitions enforced only in the UI;
- “active” booleans replacing lifecycle, approval, quality, or market status;
- one table mixing transactional stock, external snapshots, forecasts, and recommendations;
- formulas without unit/grain/time/source definitions;
- `MAX+1`, check-then-write idempotency, or dual database/message writes;
- microservices added for prestige;
- event sourcing added without replay, ordering, projection, and operations needs;
- data lake/warehouse claims without lineage and reconciliation;
- AI features without a baseline, evaluation set, human boundary, or outcome capture;
- silent fallback from missing data to zero;
- a control tower that only visualizes and cannot route accountable action.
