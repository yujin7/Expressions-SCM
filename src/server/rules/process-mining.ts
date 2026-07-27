import { classifyEvent } from "@/server/core/event-taxonomy";

export interface ProcessAuditEvent {
  id: number;
  entity: string;
  entityId: number | null;
  action: string;
  canonicalEvent: string | null;
  eventDomain: string | null;
  eventVersion: string | null;
  isStateChange: boolean | null;
  createdAt: Date | string;
  after?: unknown;
}

export interface ProcessStageMetric {
  key: string;
  entity: string;
  fromAction: string;
  fromLabel: string;
  toAction: string;
  toLabel: string;
  count: number;
  medianHours: number;
  p90Hours: number;
  avgHours: number;
  maxHours: number;
  reliable: boolean;
}

export interface ProcessVariant {
  key: string;
  entity: string;
  path: string[];
  canonicalPath: string[];
  cases: number;
  share: number;
  medianHours: number | null;
}

export interface ProcessCaseEvent {
  id: number;
  action: string;
  label: string;
  canonical: string;
  createdAt: string;
}

export interface ProcessCase {
  key: string;
  entity: string;
  entityId: number;
  docNo: string;
  startedAt: string;
  lastAt: string;
  totalHours: number | null;
  eventCount: number;
  reachedTerminal: boolean;
  path: string[];
  events: ProcessCaseEvent[];
}

export interface ProcessMiningResult {
  summary: {
    totalEvents: number;
    mappedEvents: number;
    versionedEvents: number;
    stateEvents: number;
    cases: number;
    analyzableCases: number;
    terminalCases: number;
    eventMappingRate: number;
    versionedRate: number;
    caseCoverageRate: number;
  };
  stages: ProcessStageMetric[];
  variants: ProcessVariant[];
  cases: ProcessCase[];
}

interface ClassifiedEvent {
  id: number;
  entity: string;
  entityId: number;
  action: string;
  canonical: string;
  label: string;
  createdAt: Date;
  after?: unknown;
}

const TERMINAL_ACTIONS = new Set([
  "accept",
  "close",
  "complete",
  "inbound",
  "post",
  "post_and_complete",
  "supplier_confirm",
  "writeoff",
]);

function finiteDate(value: Date | string): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function extractDocNo(value: unknown): string | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["docNo", "doc_no", "code", "no"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return null;
}

function collapseImmediateRetries(events: ClassifiedEvent[]): ClassifiedEvent[] {
  const result: ClassifiedEvent[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    if (previous?.canonical === event.canonical) continue;
    result.push(event);
  }
  return result;
}

/**
 * E3-07 pure process-mining model.
 *
 * It intentionally mines stage aggregates and case variants, never employee
 * rankings. Legacy audit rows are classified from their immutable raw action;
 * new rows use the canonical identity persisted by the audit writer.
 */
export function mineProcessEvents(
  rows: ProcessAuditEvent[],
  options: { minStageSamples?: number; maxVariants?: number; maxCases?: number } = {},
): ProcessMiningResult {
  const minStageSamples = options.minStageSamples ?? 3;
  const maxVariants = options.maxVariants ?? 8;
  const maxCases = options.maxCases ?? 20;

  let mappedEvents = 0;
  let versionedEvents = 0;
  const stateEvents: ClassifiedEvent[] = [];

  for (const row of rows) {
    const classified = classifyEvent(row.entity, row.action);
    if ((row.eventDomain ?? classified.domain) !== "system") mappedEvents += 1;
    if (row.eventVersion != null) versionedEvents += 1;
    const stateChange = row.isStateChange ?? classified.isStateChange;
    const date = finiteDate(row.createdAt);
    if (!stateChange || row.entityId == null || date == null) continue;
    stateEvents.push({
      id: row.id,
      entity: row.entity,
      entityId: row.entityId,
      action: row.action,
      canonical: row.canonicalEvent ?? classified.canonical,
      label: classified.label,
      createdAt: date,
      after: row.after,
    });
  }

  const grouped = new Map<string, ClassifiedEvent[]>();
  for (const event of stateEvents) {
    const key = `${event.entity}:${event.entityId}`;
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }

  const transitionDurations = new Map<string, {
    entity: string;
    fromAction: string;
    fromLabel: string;
    toAction: string;
    toLabel: string;
    values: number[];
  }>();
  const variantGroups = new Map<string, {
    entity: string;
    path: string[];
    canonicalPath: string[];
    durations: number[];
    cases: number;
  }>();
  const cases: ProcessCase[] = [];
  let analyzableCases = 0;
  let terminalCases = 0;

  for (const [key, rawEvents] of grouped) {
    const ordered = collapseImmediateRetries(
      [...rawEvents].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id),
    );
    if (ordered.length === 0) continue;
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    const totalHours = ordered.length >= 2
      ? Math.max(0, (last.createdAt.getTime() - first.createdAt.getTime()) / 3_600_000)
      : null;
    if (ordered.length >= 2) analyzableCases += 1;
    const reachedTerminal = ordered.some((event) => TERMINAL_ACTIONS.has(event.action));
    if (reachedTerminal) terminalCases += 1;

    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      const durationHours = Math.max(
        0,
        (current.createdAt.getTime() - previous.createdAt.getTime()) / 3_600_000,
      );
      const transitionKey = `${previous.entity}:${previous.canonical}->${current.canonical}`;
      const transition = transitionDurations.get(transitionKey) ?? {
        entity: previous.entity,
        fromAction: previous.action,
        fromLabel: previous.label,
        toAction: current.action,
        toLabel: current.label,
        values: [],
      };
      transition.values.push(durationHours);
      transitionDurations.set(transitionKey, transition);
    }

    const canonicalPath = ordered.map((event) => event.canonical);
    const path = ordered.map((event) => event.label);
    const variantKey = `${first.entity}:${canonicalPath.join(">")}`;
    const variant = variantGroups.get(variantKey) ?? {
      entity: first.entity,
      path,
      canonicalPath,
      durations: [],
      cases: 0,
    };
    variant.cases += 1;
    if (totalHours != null) variant.durations.push(totalHours);
    variantGroups.set(variantKey, variant);

    const docNo =
      ordered.map((event) => extractDocNo(event.after)).find((value): value is string => value != null) ??
      `${first.entity.toUpperCase()}-${first.entityId}`;
    cases.push({
      key,
      entity: first.entity,
      entityId: first.entityId,
      docNo,
      startedAt: first.createdAt.toISOString(),
      lastAt: last.createdAt.toISOString(),
      totalHours: totalHours == null ? null : round(totalHours),
      eventCount: ordered.length,
      reachedTerminal,
      path,
      events: ordered.map((event) => ({
        id: event.id,
        action: event.action,
        label: event.label,
        canonical: event.canonical,
        createdAt: event.createdAt.toISOString(),
      })),
    });
  }

  const stages = [...transitionDurations.entries()].map(([key, transition]) => {
    const values = [...transition.values].sort((a, b) => a - b);
    return {
      key,
      entity: transition.entity,
      fromAction: transition.fromAction,
      fromLabel: transition.fromLabel,
      toAction: transition.toAction,
      toLabel: transition.toLabel,
      count: values.length,
      medianHours: round(median(values)),
      p90Hours: round(percentile(values, 0.9)),
      avgHours: round(values.reduce((sum, value) => sum + value, 0) / values.length),
      maxHours: round(values[values.length - 1] ?? 0),
      reliable: values.length >= minStageSamples,
    };
  }).sort((a, b) => Number(b.reliable) - Number(a.reliable) || b.p90Hours - a.p90Hours || b.count - a.count);

  const caseCount = cases.length;
  const variants = [...variantGroups.entries()].map(([key, variant]) => {
    const durations = [...variant.durations].sort((a, b) => a - b);
    return {
      key,
      entity: variant.entity,
      path: variant.path,
      canonicalPath: variant.canonicalPath,
      cases: variant.cases,
      share: caseCount > 0 ? round((variant.cases / caseCount) * 100) : 0,
      medianHours: durations.length > 0 ? round(median(durations)) : null,
    };
  }).sort((a, b) => b.cases - a.cases || (b.medianHours ?? -1) - (a.medianHours ?? -1)).slice(0, maxVariants);

  cases.sort((a, b) => {
    if (a.totalHours != null && b.totalHours != null) return b.totalHours - a.totalHours;
    if (a.totalHours != null) return -1;
    if (b.totalHours != null) return 1;
    return new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime();
  });

  return {
    summary: {
      totalEvents: rows.length,
      mappedEvents,
      versionedEvents,
      stateEvents: stateEvents.length,
      cases: caseCount,
      analyzableCases,
      terminalCases,
      eventMappingRate: rows.length > 0 ? round((mappedEvents / rows.length) * 100) : 0,
      versionedRate: rows.length > 0 ? round((versionedEvents / rows.length) * 100) : 0,
      caseCoverageRate: caseCount > 0 ? round((analyzableCases / caseCount) * 100) : 0,
    },
    stages,
    variants,
    cases: cases.slice(0, maxCases),
  };
}
