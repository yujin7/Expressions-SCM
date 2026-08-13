import {
  JIANDAOYUN_FORM_CONTRACTS,
  jiandaoyunContractProjection,
  jiandaoyunContractWidgets,
  type JiandaoyunFieldRule,
  type JiandaoyunFormContract,
  type JiandaoyunNumericControlRule,
} from "./jiandaoyun-contracts";
import {
  JiandaoyunClient,
  jiandaoyunSchemaHash,
  type JiandaoyunApp,
  type JiandaoyunForm,
  type JiandaoyunRecord,
  type JiandaoyunWidget,
} from "./jiandaoyun";
import { dAdd, dCmp, dNeg, dSub } from "@/server/core/decimal";

export interface JiandaoyunFieldCoverage {
  field: string;
  populated: number;
  total: number;
}

export interface JiandaoyunSubformControl {
  target: string;
  rows: number;
  fieldCoverage: JiandaoyunFieldCoverage[];
  numericControls: JiandaoyunNumericControl[];
}

export interface JiandaoyunBusinessKeyControl {
  fields: string[];
  completeRows: number;
  missingRows: number;
  duplicateKeyGroups: number;
  duplicateRows: number;
  unique: boolean;
}

export interface JiandaoyunNumericControl {
  field: string;
  scale: 2 | 4;
  populated: number;
  parsed: number;
  invalid: number;
  total: number;
  sum: string;
}

export interface JiandaoyunFreshnessControl {
  status: "current" | "stale" | "unknown";
  maxAgeDays: number;
  currentUseBlocked: boolean;
}

export interface JiandaoyunReconciliationControl {
  key: string;
  headerField: string;
  lineFields: Array<{ subform: string; field: string }>;
  headerSum: string;
  lineSum: string;
  delta: string;
  tolerance: string;
  status: "matched" | "mismatched" | "insufficient_coverage";
  totalRows: number;
  matchedRows: number;
  mismatchedRows: number;
  insufficientRows: number;
}

export interface JiandaoyunCatalogControl {
  apps: number;
  forms: number;
  duplicateEntryIdGroups: number;
  duplicateFormNameGroups: number;
  selectedContracts: number;
  selectedViewsFound: number;
  selectedViewsMissing: number;
  selectedViewsWithSharedEntryId: number;
  selectedViewsWithDuplicateName: number;
  authorityDecisionRequired: boolean;
}

export interface JiandaoyunContractControl {
  contractKey: string;
  label: string;
  appId: string;
  entryId: string;
  schemaHash: string;
  projectionFields: number;
  sourceRows: number;
  activeRows: number;
  deletedRows: number;
  createdFrom: string | null;
  updatedThrough: string | null;
  activeUpdatedThrough: string | null;
  ageDays: number | null;
  freshness: JiandaoyunFreshnessControl;
  fieldCoverage: JiandaoyunFieldCoverage[];
  businessKey: JiandaoyunBusinessKeyControl | null;
  numericControls: JiandaoyunNumericControl[];
  reconciliations: JiandaoyunReconciliationControl[];
  subforms: JiandaoyunSubformControl[];
}

/**
 * 可随同步运行固化的最小质量摘要。只保存聚合控制，不复制业务字段值、人员信息或源记录。
 */
export interface JiandaoyunControlSummary {
  version: "jdy-control-v1";
  status: "pass" | "review";
  activeRows: number;
  deletedRows: number;
  missingFieldValues: number;
  missingBusinessKeyRows: number;
  duplicateKeyGroups: number;
  duplicateRows: number;
  invalidNumericValues: number;
  reconciliationMismatchedRows: number;
  reconciliationInsufficientRows: number;
}

function unwrap(value: unknown): unknown {
  if (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "value")
  ) {
    return (value as Record<string, unknown>).value;
  }
  return value;
}

function populated(value: unknown): boolean {
  const unwrapped = unwrap(value);
  if (unwrapped == null) return false;
  if (typeof unwrapped === "string") return unwrapped.trim() !== "";
  if (Array.isArray(unwrapped)) return unwrapped.length > 0;
  if (typeof unwrapped === "object") return Object.keys(unwrapped).length > 0;
  return true;
}

function deleted(record: JiandaoyunRecord): boolean {
  return populated(record.deleteTime ?? record.delete_time);
}

function instant(value: unknown): number | null {
  const parsed = Date.parse(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function instantRange(
  records: JiandaoyunRecord[],
  keys: readonly string[],
): { minimum: string | null; maximum: string | null } {
  let minimum: number | null = null;
  let maximum: number | null = null;
  for (const record of records) {
    const value = keys.map((key) => instant(record[key])).find((item) => item !== null) ?? null;
    if (value === null) continue;
    minimum = minimum === null ? value : Math.min(minimum, value);
    maximum = maximum === null ? value : Math.max(maximum, value);
  }
  return {
    minimum: minimum === null ? null : new Date(minimum).toISOString(),
    maximum: maximum === null ? null : new Date(maximum).toISOString(),
  };
}

function coverage(
  rows: Array<Record<string, unknown>>,
  rules: JiandaoyunFieldRule[],
): JiandaoyunFieldCoverage[] {
  return rules.map((rule) => ({
    field: rule.target,
    populated: rows.reduce((sum, row) => sum + (populated(row[rule.source]) ? 1 : 0), 0),
    total: rows.length,
  }));
}

function rulesByTarget(rules: JiandaoyunFieldRule[]): Map<string, JiandaoyunFieldRule> {
  return new Map(rules.map((rule) => [rule.target, rule]));
}

function normalizedKeyPart(value: unknown): string | null {
  const unwrapped = unwrap(value);
  if (unwrapped == null) return null;
  if (typeof unwrapped === "string") {
    const result = unwrapped.trim();
    return result === "" ? null : result.toUpperCase();
  }
  if (typeof unwrapped === "number" || typeof unwrapped === "boolean") {
    return String(unwrapped);
  }
  return null;
}

function businessKeyControl(
  rows: Array<Record<string, unknown>>,
  rules: JiandaoyunFieldRule[],
  fields: string[] | undefined,
): JiandaoyunBusinessKeyControl | null {
  if (!fields || fields.length === 0) return null;
  const sources = rulesByTarget(rules);
  const sourceFields = fields.map((target) => {
    const rule = sources.get(target);
    if (!rule) throw new Error(`简道云控制契约的业务键字段不存在: ${target}`);
    return rule.source;
  });
  const counts = new Map<string, number>();
  let missingRows = 0;
  for (const row of rows) {
    const parts = sourceFields.map((source) => normalizedKeyPart(row[source]));
    if (parts.some((part) => part === null)) {
      missingRows += 1;
      continue;
    }
    const key = JSON.stringify(parts);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicates = [...counts.values()].filter((count) => count > 1);
  return {
    fields: [...fields],
    completeRows: rows.length - missingRows,
    missingRows,
    duplicateKeyGroups: duplicates.length,
    duplicateRows: duplicates.reduce((sum, count) => sum + count, 0),
    unique: missingRows === 0 && duplicates.length === 0,
  };
}

function decimalText(value: unknown): string | null {
  const unwrapped = unwrap(value);
  if (unwrapped == null) return null;
  if (typeof unwrapped !== "string" && typeof unwrapped !== "number") return null;
  const result = String(unwrapped).trim();
  return /^-?\d+(?:\.\d+)?$/.test(result) ? result : null;
}

function numericControls(
  rows: Array<Record<string, unknown>>,
  rules: JiandaoyunFieldRule[],
  controls: JiandaoyunNumericControlRule[] | undefined,
): JiandaoyunNumericControl[] {
  if (!controls || controls.length === 0) return [];
  const sources = rulesByTarget(rules);
  return controls.map((control) => {
    const rule = sources.get(control.target);
    if (!rule) throw new Error(`简道云控制契约的数值字段不存在: ${control.target}`);
    let populatedRows = 0;
    let parsed = 0;
    let sum = "0.000000";
    for (const row of rows) {
      const raw = row[rule.source];
      if (!populated(raw)) continue;
      populatedRows += 1;
      const value = decimalText(raw);
      if (value === null) continue;
      try {
        sum = dAdd(sum, value, 6);
        parsed += 1;
      } catch {
        // Values outside the fixed-decimal contract remain explicit invalid controls.
      }
    }
    return {
      field: control.target,
      scale: control.scale,
      populated: populatedRows,
      parsed,
      invalid: populatedRows - parsed,
      total: rows.length,
      sum: dAdd("0", sum, control.scale),
    };
  });
}

function completeNumeric(control: JiandaoyunNumericControl): boolean {
  return control.invalid === 0 && control.parsed === control.total;
}

function absoluteDecimal(value: string, scale: 2 | 4): string {
  return dCmp(value, "0") < 0 ? dNeg(value, scale) : dAdd("0", value, scale);
}

function reconciliationControls(
  contract: JiandaoyunFormContract,
  rows: JiandaoyunRecord[],
  headers: JiandaoyunNumericControl[],
  subforms: JiandaoyunSubformControl[],
): JiandaoyunReconciliationControl[] {
  const rules = contract.reconciliations;
  if (!rules || rules.length === 0) return [];
  const headerFields = rulesByTarget(contract.fields);
  return rules.map((rule) => {
    const header = headers.find((control) => control.field === rule.headerTarget);
    const headerRule = headerFields.get(rule.headerTarget);
    if (!header || !headerRule) {
      throw new Error(`简道云对账契约缺失表头控制字段: ${rule.headerTarget}`);
    }
    const lineControls = rule.lineTargets.map((target) => {
      const subform = subforms.find((control) => control.target === target.subformTarget);
      const numeric = subform?.numericControls.find((control) =>
        control.field === target.fieldTarget);
      const contractSubform = contract.subforms?.find((item) =>
        item.target === target.subformTarget);
      const fieldRule = contractSubform?.items.find((item) =>
        item.target === target.fieldTarget);
      if (!subform || !numeric || !contractSubform || !fieldRule) {
        throw new Error(
          `简道云对账契约缺失明细控制字段: ${target.subformTarget}.${target.fieldTarget}`,
        );
      }
      return { numeric, contractSubform, fieldRule };
    });
    let lineSum = "0.000000";
    for (const line of lineControls) lineSum = dAdd(lineSum, line.numeric.sum, 6);
    lineSum = dAdd("0", lineSum, rule.scale);
    const delta = dSub(header.sum, lineSum, rule.scale);
    let matchedRows = 0;
    let mismatchedRows = 0;
    let insufficientRows = 0;
    for (const row of rows) {
      const headerValue = decimalText(row[headerRule.source]);
      if (headerValue === null) {
        insufficientRows += 1;
        continue;
      }
      let rowLineSum = "0.000000";
      let complete = true;
      for (const line of lineControls) {
        const lineRows = subformRows([row], line.contractSubform.source);
        for (const lineRow of lineRows) {
          const value = decimalText(lineRow[line.fieldRule.source]);
          if (value === null) {
            complete = false;
            continue;
          }
          try {
            rowLineSum = dAdd(rowLineSum, value, 6);
          } catch {
            complete = false;
          }
        }
      }
      if (!complete) {
        insufficientRows += 1;
        continue;
      }
      const rowDelta = dSub(headerValue, rowLineSum, rule.scale);
      if (dCmp(absoluteDecimal(rowDelta, rule.scale), rule.tolerance) <= 0) {
        matchedRows += 1;
      } else {
        mismatchedRows += 1;
      }
    }
    const aggregateComplete = completeNumeric(header)
      && lineControls.every((line) => completeNumeric(line.numeric));
    const status = mismatchedRows > 0
      ? "mismatched"
      : insufficientRows > 0 || rows.length === 0 || !aggregateComplete
        ? "insufficient_coverage"
        : "matched";
    return {
      key: rule.key,
      headerField: rule.headerTarget,
      lineFields: rule.lineTargets.map((target) => ({
        subform: target.subformTarget,
        field: target.fieldTarget,
      })),
      headerSum: header.sum,
      lineSum,
      delta,
      tolerance: rule.tolerance,
      status,
      totalRows: rows.length,
      matchedRows,
      mismatchedRows,
      insufficientRows,
    };
  });
}

function freshnessControl(
  ageDays: number | null,
  maxAgeDays = 90,
): JiandaoyunFreshnessControl {
  if (ageDays === null) {
    return { status: "unknown", maxAgeDays, currentUseBlocked: true };
  }
  const status = ageDays <= maxAgeDays ? "current" : "stale";
  return { status, maxAgeDays, currentUseBlocked: status !== "current" };
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

export function auditJiandaoyunCatalog(
  apps: JiandaoyunApp[],
  forms: JiandaoyunForm[],
  contracts: JiandaoyunFormContract[] = JIANDAOYUN_FORM_CONTRACTS,
): JiandaoyunCatalogControl {
  const entryCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  const viewKeys = new Set<string>();
  for (const form of forms) {
    entryCounts.set(form.entryId, (entryCounts.get(form.entryId) ?? 0) + 1);
    const name = normalizedName(form.name);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    viewKeys.add(`${form.appId}:${form.entryId}`);
  }
  const selectedViewsFound = contracts.reduce((sum, contract) =>
    sum + (viewKeys.has(`${contract.appId}:${contract.entryId}`) ? 1 : 0), 0);
  const selectedViewsWithSharedEntryId = contracts.reduce((sum, contract) =>
    sum + ((entryCounts.get(contract.entryId) ?? 0) > 1 ? 1 : 0), 0);
  const contractFormNames = new Map(
    forms.map((form) => [`${form.appId}:${form.entryId}`, normalizedName(form.name)]),
  );
  const selectedViewsWithDuplicateName = contracts.reduce((sum, contract) => {
    const name = contractFormNames.get(`${contract.appId}:${contract.entryId}`);
    return sum + (name !== undefined && (nameCounts.get(name) ?? 0) > 1 ? 1 : 0);
  }, 0);
  const selectedViewsMissing = contracts.length - selectedViewsFound;
  return {
    apps: apps.length,
    forms: forms.length,
    duplicateEntryIdGroups: [...entryCounts.values()].filter((count) => count > 1).length,
    duplicateFormNameGroups: [...nameCounts.values()].filter((count) => count > 1).length,
    selectedContracts: contracts.length,
    selectedViewsFound,
    selectedViewsMissing,
    selectedViewsWithSharedEntryId,
    selectedViewsWithDuplicateName,
    authorityDecisionRequired: selectedViewsMissing > 0
      || selectedViewsWithSharedEntryId > 0
      || selectedViewsWithDuplicateName > 0,
  };
}

function subformRows(
  records: JiandaoyunRecord[],
  source: string,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const value = unwrap(records[recordIndex][source]);
    if (value == null) continue;
    if (!Array.isArray(value)) {
      throw new Error(`简道云控制总量 ${source} 第 ${recordIndex + 1} 行不是子表数组`);
    }
    for (let lineIndex = 0; lineIndex < value.length; lineIndex++) {
      const row = value[lineIndex];
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error(
          `简道云控制总量 ${source} 第 ${recordIndex + 1}.${lineIndex + 1} 行结构非法`,
        );
      }
      rows.push(row as Record<string, unknown>);
    }
  }
  return rows;
}

export function inspectJiandaoyunContractControl(
  contract: JiandaoyunFormContract,
  widgets: JiandaoyunWidget[],
  records: JiandaoyunRecord[],
  now = new Date(),
): JiandaoyunContractControl {
  const selectedWidgets = jiandaoyunContractWidgets(contract, widgets);
  const projection = jiandaoyunContractProjection(contract);
  const activeRecords = records.filter((record) => !deleted(record));
  const created = instantRange(records, ["createTime", "create_time"]);
  const updated = instantRange(records, ["updateTime", "update_time"]);
  const activeUpdated = instantRange(activeRecords, ["updateTime", "update_time"]);
  const updatedMaximum = activeUpdated.maximum === null ? null : Date.parse(activeUpdated.maximum);
  const topRows = activeRecords as Array<Record<string, unknown>>;
  const ageDays = updatedMaximum === null
    ? null
    : Math.max(0, Math.floor((now.getTime() - updatedMaximum) / 86_400_000));
  const headerNumericControls = numericControls(
    topRows,
    contract.fields,
    contract.numericControls,
  );
  const subformControls = (contract.subforms ?? []).map((subform) => {
    const rows = subformRows(activeRecords, subform.source);
    return {
      target: subform.target,
      rows: rows.length,
      fieldCoverage: coverage(rows, subform.items),
      numericControls: numericControls(rows, subform.items, subform.numericControls),
    };
  });
  return {
    contractKey: contract.key,
    label: contract.label,
    appId: contract.appId,
    entryId: contract.entryId,
    schemaHash: jiandaoyunSchemaHash(selectedWidgets),
    projectionFields: projection.length,
    sourceRows: records.length,
    activeRows: activeRecords.length,
    deletedRows: records.length - activeRecords.length,
    createdFrom: created.minimum,
    updatedThrough: updated.maximum,
    activeUpdatedThrough: activeUpdated.maximum,
    ageDays,
    freshness: freshnessControl(ageDays, contract.freshnessMaxAgeDays),
    fieldCoverage: coverage(topRows, contract.fields),
    businessKey: businessKeyControl(topRows, contract.fields, contract.businessKey),
    numericControls: headerNumericControls,
    reconciliations: reconciliationControls(
      contract,
      activeRecords,
      headerNumericControls,
      subformControls,
    ),
    subforms: subformControls,
  };
}

export function summarizeJiandaoyunContractControl(
  control: JiandaoyunContractControl,
): JiandaoyunControlSummary {
  const allCoverage = [
    ...control.fieldCoverage,
    ...control.subforms.flatMap((subform) => subform.fieldCoverage),
  ];
  const allNumeric = [
    ...control.numericControls,
    ...control.subforms.flatMap((subform) => subform.numericControls),
  ];
  const missingBusinessKeyRows = control.businessKey?.missingRows ?? 0;
  const duplicateKeyGroups = control.businessKey?.duplicateKeyGroups ?? 0;
  const duplicateRows = control.businessKey?.duplicateRows ?? 0;
  const invalidNumericValues = allNumeric.reduce((sum, item) => sum + item.invalid, 0);
  const reconciliationMismatchedRows = control.reconciliations.reduce(
    (sum, item) => sum + item.mismatchedRows,
    0,
  );
  const reconciliationInsufficientRows = control.reconciliations.reduce(
    (sum, item) => sum + item.insufficientRows,
    0,
  );
  const review = missingBusinessKeyRows > 0
    || duplicateRows > 0
    || invalidNumericValues > 0
    || reconciliationMismatchedRows > 0
    || reconciliationInsufficientRows > 0;
  return {
    version: "jdy-control-v1",
    status: review ? "review" : "pass",
    activeRows: control.activeRows,
    deletedRows: control.deletedRows,
    missingFieldValues: allCoverage.reduce(
      (sum, item) => sum + Math.max(0, item.total - item.populated),
      0,
    ),
    missingBusinessKeyRows,
    duplicateKeyGroups,
    duplicateRows,
    invalidNumericValues,
    reconciliationMismatchedRows,
    reconciliationInsufficientRows,
  };
}

export async function auditJiandaoyunContracts(
  client: Pick<JiandaoyunClient, "listWidgets" | "listRecords">,
  options: {
    contracts?: JiandaoyunFormContract[];
    now?: Date;
  } = {},
): Promise<JiandaoyunContractControl[]> {
  const contracts = options.contracts ?? JIANDAOYUN_FORM_CONTRACTS;
  const now = options.now ?? new Date();
  const results: JiandaoyunContractControl[] = [];
  for (const contract of contracts) {
    const widgets = await client.listWidgets(contract.appId, contract.entryId);
    const projection = jiandaoyunContractProjection(contract);
    const records = await client.listRecords(contract.appId, contract.entryId, projection);
    results.push(inspectJiandaoyunContractControl(contract, widgets, records, now));
  }
  return results;
}
