# Authoritative research sources

Last researched: 2026-07-25. Re-verify current primary sources before making legal, regulatory, security-standard, or version-sensitive claims.
This is a research index, not live project authority: current status belongs to `docs/NOW.md`, and
product/market scope or hard-gate decisions belong to `docs/spec/CURRENT.md` with legal/compliance
owner sign-off where applicable.

## Cosmetics regulation and quality

### China

- [PRC Regulation on the Supervision and Administration of Cosmetics (State Council Order 727)](https://app.www.gov.cn/govdata/gov/202006/29/460173/article.html) — risk-based ingredient/product regulation, registrant/filer responsibilities, quality and safety obligations, storage/transport, recall and supervision.
- [NMPA Good Manufacturing Practice for Cosmetics announcement](https://english.nmpa.gov.cn/2022-01/07/c_736590.htm) — GMP applies to registrants, filing applicants, and contract manufacturers; design supplier/site qualification, materials, production, quality, storage, and shipment evidence accordingly.
- [NMPA Provisions for Supervision and Administration of Manufacturing and Marketing of Cosmetics](https://english.nmpa.gov.cn/2022-10/25/c_961745.htm) — quality system and production/marketing records.
- [NMPA Provisions for Registration and Filing of Cosmetics](https://english.nmpa.gov.cn/2022-06/30/c_785637.htm) — registration/filing roles and workflows.
- [NMPA 2024 safety-assessment measures](https://english.nmpa.gov.cn/2024-04/22/c_1049743.htm) and [interpretation](https://english.nmpa.gov.cn/2024-06/07/c_994356.htm) — distinguish product-risk-based submission paths while retaining the complete supporting assessment.
- [NMPA 2025 existing cosmetic ingredients inventory update](https://english.nmpa.gov.cn/2025-07/21/c_1118071.htm) — ingredient inventories are dynamically updated; do not freeze a permanent allowed-ingredient list in application code.

Implementation implication: version regulatory source data, market, effective dates, responsible entity, dossier/filing state, formula/ingredient identity, claims evidence, manufacturer/site, and release gates. Browse the current NMPA source before implementing a specific rule.

### European Union

- [Regulation (EC) No 1223/2009 on cosmetic products, consolidated 2026-05-01 access](https://eur-lex.europa.eu/eli/reg/2009/1223/2026-05-01/eng) — responsible person, safety assessment/report, Product Information File, GMP, notification, labeling/batch identification, supply-chain identification, serious undesirable effects, and corrective action.
- [EU Cosmetic Product Notification Portal](https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-product-notification-portal_en) and [harmonised cosmetics standards](https://single-market-economy.ec.europa.eu/single-market/goods/european-standards/harmonised-standards/cosmetic-products_en) — notification and recognized standards context.

Implementation implication: keep market-specific responsible person, notification, safety/PIF evidence, claims/label version, batch identity, distribution trace, and retention. Check the consolidated text and applicable amendments at the time of design.

### United States

- [FDA FD&C Act Chapter VI: Cosmetics](https://www.fda.gov/regulatory-information/federal-food-drug-and-cosmetic-act-fdc-act/fdc-act-chapter-vi-cosmetics) — current statutory index for adverse events, GMP authority, registration/listing, safety substantiation, labeling, records, and mandatory recall under MoCRA.
- [FDA MoCRA overview](https://www.fda.gov/cosmetics/cosmetics-laws-regulations/modernization-cosmetics-regulation-act-2022-mocra) and [facility/product registration and listing](https://www.fda.gov/cosmetics/registration-listing-cosmetic-product-facilities-and-products) — current implementation hub and submission obligations.
- [FDA Registration and Listing of Cosmetic Product Facilities and Products guidance](https://www.fda.gov/media/170732/download) — facility/product listing data and update workflows.
- [FDA Recall Policy for Cosmetics](https://www.fda.gov/cosmetics/cosmetics-compliance-enforcement/fda-recall-policy-cosmetics) — recall planning, lot coding, distribution records, effectiveness checks, and MoCRA mandatory recall authority.
- [FDA cosmetic/drug classification](https://www.fda.gov/cosmetics/cosmetics-laws-regulations/it-cosmetic-drug-or-both-or-it-soap) and [shelf life/expiration dating](https://www.fda.gov/cosmetics/cosmetics-labeling/shelf-life-and-expiration-dating-cosmetics) — derive classification from intended use/claims and preserve internal stability evidence even when label rules differ.
- [FDA Cosmetics Guidance Documents](https://www.fda.gov/guidance-documents) — current and draft guidance status; distinguish final requirements from draft/nonbinding guidance.

Implementation implication: model responsible person, facility and product listing, safety evidence, serious adverse-event intake/reporting evidence, contact/label version, distribution trace, recall scope/effectiveness, and current guidance status.

### International GMP

- [ISO 22716:2007](https://www.iso.org/standard/36437.html) — cosmetics GMP guidance covering production, control, storage, and shipment; ISO reports it was confirmed in 2022 and remains current as of this research date.

Do not claim certification or full conformance from software controls alone.

## Traceability and supply-chain operating models

- [GS1 Global Traceability Standard](https://www.gs1.org/standards/gs1-global-traceability-standard/current-standard) — interoperable end-to-end traceability across objects, parties, locations, and critical tracking events.
- [GS1 EPCIS current standard](https://ref.gs1.org/standards/epcis/) and [version archive](https://ref.gs1.org/standards/epcis/archive) — event semantics for what/when/where/why/how, including JSON/JSON-LD, REST capture/query, sensor and certification data. The current ratified version is 2.0.1 as of 2026-07-25; use an immutable versioned URI in implementation evidence.
- [GS1 Application Identifiers](https://ref.gs1.org/ai/?lang=en) and [2D retail implementation guidance](https://ref.gs1.org/guidelines/2d-in-retail/) — GTIN/lot/date carrier semantics and interoperability direction.
- [ASCM SCOR Digital Standard](https://www.ascm.org/corporate-solutions/standards-tools/scor-ds/) and [SCOR performance model](https://scor.ascm.org/performance/introduction) — organize plan/source/transform/deliver/return/orchestrate and balance reliability, responsiveness, agility/resilience, cost/profit, assets, environmental, and social outcomes.
- [ASCM Sales and Operations Planning](https://www.ascm.org/topics/sales-and-operations-planning/) and [Integrated Business Planning](https://www.ascm.org/ascm-insights/making-the-case-for-integrated-business-planning/) — planning cadence and cross-functional/financial alignment.
- [ISO 28000:2022](https://www.iso.org/standard/79612.html) — security and resilience management systems with supply-chain relevance.
- [ISO 8000-61 data-quality management](https://www.iso.org/standard/63086.html), [ISO 8000-110 master-data semantics](https://www.iso.org/standard/78501.html), and [W3C PROV-O](https://www.w3.org/TR/prov-o/) — data quality, semantic identity, and provenance references.

Use standards as semantic and control references. Tailor the implementation to company scale, product risk, partner capabilities, and destination markets.

## Forecasting and decision science

- [Forecasting: Principles and Practice, current online edition](https://otexts.com/fpp3/) — exploratory analysis, baselines, temporal evaluation, time-series methods, and operational use.
- [Hierarchical and grouped forecasting](https://otexts.com/fpp3/hierarchical.html) and [forecast reconciliation](https://otexts.com/fpp3/reconciliation.html) — keep SKU/channel/brand/total forecasts coherent.
- [M5 Uncertainty competition findings](https://www.sciencedirect.com/science/article/pii/S0169207021001722) — retail planning benefits from probabilistic forecasts across hierarchical series, not point estimates alone.
- [Google Research: probabilistic top-down hierarchical forecasting](https://research.google/pubs/a-top-down-approach-to-hierarchically-coherent-probabilistic-forecasting/) — primary research example; treat as an option to evaluate, not a mandatory architecture.

Prefer simple baselines and business-policy backtests before advanced models. Guard against leakage, hierarchy inconsistency, and optimizing model error without inventory/service impact.

## AI governance, security, and architecture

- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework), [NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/), and [NIST Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf) — govern, map, measure, and manage; define human oversight, testing/evaluation/verification/validation, monitoring, incident handling, appeal/override, and third-party model risk. NIST notes AI RMF 1.0 is being revised, so verify status.
- [NIST SP 800-218A secure AI development](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218A.pdf) and [NIST adversarial ML taxonomy](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-2e2025.pdf) — secure lifecycle and adversarial evaluation references.
- [ISO/IEC 42001 AI management systems](https://www.iso.org/standard/42001), [ISO/IEC 23894 AI risk management](https://www.iso.org/standard/77304.html), and [ISO/IEC 42005 AI impact assessment](https://www.iso.org/standard/42005) — organizational governance references; do not claim certification from following this skill.
- [OWASP Application Security Verification Standard](https://owasp.org/www-project-application-security-verification-standard/) — current web-application security verification baseline; ASVS 5.0.0 was the latest stable version on the research date.
- [OWASP Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) — restrict tool scope, permissions, autonomy, and impact.
- [AWS transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) — avoid dual-write loss; commit state plus event atomically and use idempotent consumers.
- [CloudEvents specification](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md) and [AsyncAPI concepts](https://www.asyncapi.com/docs/concepts/asyncapi-document) — versioned event envelopes and machine-readable asynchronous contracts.
- [OpenTelemetry messaging semantic conventions](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/) and [Google SRE monitoring guidance](https://sre.google/sre-book/monitoring-distributed-systems/) — trace continuity and outcome-oriented monitoring.
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices) — tool authorization and agent integration security when MCP is used.

Treat vendor architecture pages as pattern references, not evidence that the project needs the vendor or microservices.

## Sustainability and emerging market obligations

- [EU Packaging and Packaging Waste Regulation](https://environment.ec.europa.eu/topics/waste-and-recycling/packaging-waste_en), [EU Deforestation Regulation](https://environment.ec.europa.eu/topics/forests/deforestation/regulation-deforestation-free-products_en), [EU microplastics restriction](https://single-market-economy.ec.europa.eu/sectors/chemicals/reach/restrictions/commission-regulation-eu-20232055-restriction-microplastics-intentionally-added-products_en), and [EU corporate sustainability due diligence](https://commission.europa.eu/topics/business-and-industry/doing-business-eu/sustainability-due-diligence-responsible-business/corporate-sustainability-due-diligence_en) — use as current scope/effective-date sources for packaging, commodity provenance, ingredient transitions, and supplier evidence.

These regimes have staged dates, thresholds, product-code scope, and amendments. Store reusable evidence now, but turn a rule into a hard gate only after current scope analysis and legal/compliance sign-off.

## Research discipline

When updating this reference:

1. Prefer statutes, regulators, standards bodies, official specifications, and primary research.
2. Record publication/effective/status dates and whether material is draft, guidance, standard, or binding law.
3. Convert sources into design implications; do not paste long excerpts.
4. Separate global reusable controls from market-specific legal requirements.
5. Keep a legal/compliance owner in the operating process for final interpretation.
