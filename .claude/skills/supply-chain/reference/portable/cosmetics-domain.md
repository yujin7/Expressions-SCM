# Cosmetics supply-chain domain playbook

## Contents

1. Capability model
2. Product, formula, and market identity
3. Interoperable identity and events
4. Planning for fast-growth beauty brands
5. Supplier and outsourced manufacturing
6. Quality, lot, expiry, and recall
7. Inventory and fulfillment
8. Metrics and decision loops
9. Sustainability and due-diligence evidence
10. Exception checklist

## 1. Capability model

Cover the connected operating system, not isolated screens:

- **Orchestrate:** strategy, segmentation, S&OP/IBP, scenarios, risk, compliance, master-data governance, KPI governance.
- **Plan:** demand, launch/promotion, supply, material, capacity, inventory, cash, and constrained scenario planning.
- **Source:** supplier qualification, approved sources, RFQ/quotes, contracts, MOQ/lead time, purchase, inbound quality, performance, risk.
- **Make/委外:** formula/BOM/routing/version, batch record, kitting, issue/return, yield, in-process QC, release, processing fee, settlement.
- **Deliver:** allocation, warehouse execution, FEFO, channel orders, shipping, external warehouse snapshots, proof and reconciliation.
- **Return:** customer/marketplace returns, supplier returns, processor returns, rework, scrap/destruction, chargeback, complaint/adverse-event linkage.
- **Enable:** identity, permissions, audit, data integration, documents, notifications, analytics, AI evaluation, and operations.

Pair every capability with a decision, accountable role, authoritative data, exception route, and metric.

## 2. Product, formula, and market identity

Model these separately:

- product family/SPU;
- sellable SKU/variant and package size;
- formula and formula version;
- packaging/BOM and BOM version;
- component/raw-material SKU and approved supplier/manufacturer;
- manufacturing site, responsible party/registrant, and contract manufacturer;
- destination market and regulatory classification;
- label/artwork/claims/language version;
- notification/registration/dossier and effective dates;
- finished lot and material/component lots;
- quality specification, test method, COA/result, disposition, and release;
- shelf life, PAO where applicable, storage conditions, and expiry policy.

Do not assume one SKU maps to one formula, one market, one label, or one manufacturer for all time. Use effective-dated, approved versions and snapshot them into execution documents.

Treat claims and ingredient restrictions as market-specific release gates. Store evidence and status; do not let a generic `active` flag stand in for regulatory clearance.

Maintain market-specific capabilities for the responsible person/registrant/filer, manufacturing facility, product registration/listing/notification, safety assessment and substantiation, dossier/PIF, claims, adverse events, recall, and retention calendar. Classify the product by intended use and claims in each market; a global “cosmetic” flag is insufficient.

## 3. Interoperable identity and events

Prefer:

- GTIN for trade items, GLN for parties/locations, and SSCC for logistics units;
- GS1 Application Identifiers such as GTIN, batch/lot, and expiry/best-before where applicable;
- internal immutable IDs plus governed external-ID crosswalks;
- EPCIS-compatible critical tracking events answering what, when, where, why, and how.

Represent receiving, sampling, inspection/release, transformation, packing/aggregation, shipping, receipt, sale, return, rework, and destruction as traceable events. Preserve bulk-to-pack transformations: one bulk batch may create several finished lots, packages, or market SKUs.

Use item serialization only where authenticity, diversion, product value, or recall precision justifies its cost. Treat 2D/Digital Link industry targets as interoperability direction, not automatic legal requirements.

## 4. Planning for fast-growth beauty brands

Beauty demand is shaped by launches, creators, promotions, livestreams, marketplaces, channel stock, cannibalization, discontinuations, and long-tail variants. Design for:

- new-product cold starts using analogous-product cohorts plus explicit launch assumptions;
- event/promotion uplift separated from baseline demand;
- sell-in versus sell-through and shipments versus consumer demand;
- returns/cancellations and channel latency;
- product and channel hierarchies whose forecasts reconcile;
- intermittent demand and zero-heavy tail SKUs;
- capacity, MOQ, order multiples, component sharing, shelf life, cash, and supplier lead-time constraints;
- scenario ranges, not a single unexplained number.

Observed sales are not always demand. Treat stockout periods as censored and preserve availability, price, promotion, returns, launch, cannibalization, and lifecycle signals.

Use a rolling decision cadence:

1. Reconcile actuals and data freshness.
2. Produce baseline and event-adjusted probabilistic forecasts.
3. Compare demand, supply, inventory, WIP, capacity, cash, and regulatory readiness.
4. Generate constrained scenarios with service, risk, expiry, margin, and cash trade-offs.
5. Record consensus, overrides, assumptions, owner, and horizon.
6. Release only approved plans into executable requests/orders.
7. Measure forecast and decision outcomes; learn lead time and override performance.

Use a practical dual cadence: longer-horizon monthly IBP/S&OP at product-family/channel/market level and short-horizon weekly S&OE at SKU/location level. Tailor horizons to actual lead times instead of copying a generic calendar.

Always show planning quantities at a declared grain and time bucket. Preserve the raw forecast, override, consensus plan, and execution plan separately.

Useful measures:

- forecast bias and WAPE/MASE by horizon and cohort;
- quantile/pinball loss and interval coverage for uncertainty;
- service level/fill rate, stockout rate, lost-sales proxy;
- days of supply, inventory turns, aging/expiry exposure;
- plan adherence, schedule adherence, and expedite rate;
- supplier on-time-in-full and quality acceptance;
- cash-to-cash and working-capital exposure.

Do not optimize forecast accuracy in isolation. Backtest the downstream replenishment or allocation policy because inventory outcomes may not track small accuracy gains.

## 5. Supplier and outsourced manufacturing

Model supplier lifecycle as controlled transitions:

`candidate → qualification → approved pool → active → conditional/paused → exit/blacklist`

Include:

- legal identity, site, category capability, market applicability, contacts, bank/settlement data;
- licenses/certificates, expiry, verification status, scope, attachments;
- audits, samples/trials, CAPA, complaints, quality events, and change notifications;
- approved material/formula/site combinations;
- capacity, MOQ, standard and learned lead time, price history, currencies/tax/units;
- scorecard definitions, source observations, period, sample size, and owner;
- dependency concentration, alternate source readiness, and continuity risk.

For outsourced production:

1. Freeze the approved formula/BOM and commercial inputs at order approval.
2. Compute gross material demand from explicit, non-duplicated planning-loss rules.
3. Net against eligible inventory and open supply at a declared cutoff.
4. Separate materials PO from processing-fee settlement.
5. Support split kitting, partial issue, partial production, partial receipt, leftovers, processor advance material, and short close.
6. Capture issued and returned quantity by material and lot.
7. Hold received finished lots until QC disposition when required.
8. Calculate settlement per material with compatible units; distinguish planned loss, actual usage, allowed tolerance, recoverable leftovers, concession, scrap, and deduction.
9. Clear or explain processor material balances at closure.
10. Preserve the full evidence chain for dispute and replay.

Never let a status label substitute for document facts. Derive progress from approved events and quantities.

## 6. Quality, lot, expiry, and recall

Design quality as a first-class state, not a note:

- sampling/inspection plan and specification version;
- received, sampled, quarantined, passed, failed, concession, rework, returned, destroyed, released;
- measured result, method, limits, units, analyst, reviewer, time, attachment, and deviation/CAPA;
- independent physical quantity and quality disposition;
- explicit rules for whether concession quantity counts toward production, inventory availability, settlement, and claims.

Maintain batch genealogy:

`supplier material lot → receipt/QC → issued lot → manufacturing batch → finished lot/QC release → warehouse/channel/customer destination`

Support one-step-back and one-step-forward tracing at minimum, plus full internal genealogy where execution captures it. Preserve transformations, splits, merges, repacks, relabeling, rework, and destruction.

For expiry:

- store production/receipt/expiry dates and the rule/source that generated expiry;
- use FEFO among eligible, released stock;
- prevent allocation/shipment of expired, blocked, recalled, or quarantined lots;
- separate regulatory shelf life from commercial channel thresholds;
- model remaining-shelf-life requirements by channel/customer/market;
- simulate expiry exposure against demand, not just a fixed days-to-expiry alert.

Recall readiness must answer quickly:

- Which finished lots and SKUs contain the affected lot/ingredient?
- Where is each affected quantity now, including external warehouses and in-transit?
- Which customers/channels received it, when, and how much?
- What is quarantined, returned, destroyed, unrecovered, or unresponsive?
- Which regulator/market obligations, communications, evidence, and effectiveness checks apply?

When traceability data is missing, widen the affected scope to the smallest boundary proven safe and show the unknown quantity/coverage explicitly. Missing evidence must never shrink recall scope.

Run mock recalls and measure time-to-scope, contact completeness, quantity reconciliation, and closure evidence.

## 7. Inventory and fulfillment

Keep these quantities distinct:

- physical on-hand;
- released/eligible;
- quality hold/quarantine;
- reserved/allocated/locked;
- available-to-promise;
- projected available balance;
- approved inbound/open supply;
- in-transit;
- external snapshot/reference;
- damaged, expired, recalled, or pending destruction.

Define formulas with exact inclusion rules and timestamps. Never label a metric “available” without declaring reservations, holds, inbound, snapshots, and cutoff.

Use immutable movements and derived balances. Every movement needs:

- source document/action and idempotency key;
- from/to location and ownership where applicable;
- SKU, lot/batch, quantity, unit, and business time;
- quality/status effect;
- actor/approver and audit correlation;
- reversal relationship if corrected.

Treat external marketplace/3PL inventory as coverage with freshness and reconciliation, not as trustworthy real-time stock unless the integration contract proves it.

Model samples, testers, gifts-with-purchase, consignment, virtual/physical kits, and returns explicitly. Virtual kits consume component ATP; physical kitting/repacking creates transformation genealogy. Do not return opened, tampered, or uncertain-condition cosmetics automatically to sellable stock.

## 8. Metrics and decision loops

Balance the scorecard across:

- **Reliability:** perfect order/supplier order, OTIF, quantity/document/quality correctness.
- **Responsiveness:** order, source, make, QC-release, and replenishment cycle times.
- **Agility/resilience:** time to detect, time to recover, alternate-source/capacity readiness, scenario exposure.
- **Cost/profit:** purchase variance, expedite, scrap, processing, logistics, COGS/margin when source data supports it.
- **Assets:** days of supply, turns, aging, expiry, cash-to-cash, working capital.
- **Environmental/social:** material, waste, water/energy/emissions, supplier labor/compliance evidence when in scope.

For each KPI define:

- business question and owner;
- numerator, denominator, grain, filters, time zone, event time, and as-of rule;
- source tables and lineage;
- data completeness/freshness threshold;
- target/baseline and action when breached;
- test fixture and reconciliation method.

Do not invent values for missing KPI baselines. Start collection, label provisional values, and assign an owner and lock date.

## 9. Sustainability and due-diligence evidence

Future-proof the data model without claiming every rule applies:

- packaging component, material, weight, color/additive, recycled content, recyclability evidence, supplier, market, and EPR responsibility;
- ingredient/commodity origin, producer/site, country/geolocation where required, customs code, certification, and chain-of-custody;
- supplier environmental/human-rights risk, audit, CAPA, evidence scope, validity, and version;
- material, waste, water, energy, and emissions facts with method, boundary, period, and source.

Determine scope from legal entity, company size, destination market, commodity/product code, and effective date. Re-verify current PPWR, EUDR, microplastics, due-diligence, PFAS, and packaging-EPR rules from primary sources before converting them into hard gates.

## 10. Exception checklist

Cover at least:

- first purchase/no price baseline;
- unit or tax mismatch;
- substitute component and formula/BOM change;
- supplier/site not approved for destination market;
- partial, excess, short, late, rejected, or duplicate delivery;
- mixed lot, missing lot, damaged label, or invalid expiry;
- concession, rework, scrap, supplier return, processor return, and customer return;
- processor advance material and negative processor balance;
- order cancellation after downstream documents or movements exist;
- stale external inventory or incomplete channel/warehouse coverage;
- alias collision, duplicate barcode, missing master, and source row ambiguity;
- promotion spike, launch delay, discontinued SKU, and cannibalization;
- recall/adverse event, blocked lot, and market withdrawal;
- integration retry, out-of-order event, timeout after commit, and replay;
- close with residual WIP/material/financial exposure.

Require a visible owner and work queue for exceptions. Silent suppression is not resolution.
