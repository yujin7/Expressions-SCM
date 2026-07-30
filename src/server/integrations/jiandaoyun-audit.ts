import {
  JIANDAOYUN_FORM_CONTRACTS,
  jiandaoyunContractProjection,
  jiandaoyunContractWidgets,
  type JiandaoyunFieldRule,
  type JiandaoyunFormContract,
} from "./jiandaoyun-contracts";
import {
  JiandaoyunClient,
  jiandaoyunSchemaHash,
  type JiandaoyunRecord,
} from "./jiandaoyun";

export interface JiandaoyunFieldCoverage {
  field: string;
  populated: number;
  total: number;
}

export interface JiandaoyunSubformControl {
  target: string;
  rows: number;
  fieldCoverage: JiandaoyunFieldCoverage[];
}

export interface JiandaoyunContractControl {
  contractKey: string;
  label: string;
  appId: string;
  entryId: string;
  schemaHash: string;
  projectionFields: number;
  sourceRows: number;
  deletedRows: number;
  createdFrom: string | null;
  updatedThrough: string | null;
  ageDays: number | null;
  fieldCoverage: JiandaoyunFieldCoverage[];
  subforms: JiandaoyunSubformControl[];
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
    const selectedWidgets = jiandaoyunContractWidgets(contract, widgets);
    const projection = jiandaoyunContractProjection(contract);
    const records = await client.listRecords(contract.appId, contract.entryId, projection);
    const created = instantRange(records, ["createTime", "create_time"]);
    const updated = instantRange(records, ["updateTime", "update_time"]);
    const updatedMaximum = updated.maximum === null ? null : Date.parse(updated.maximum);
    const topRows = records as Array<Record<string, unknown>>;
    results.push({
      contractKey: contract.key,
      label: contract.label,
      appId: contract.appId,
      entryId: contract.entryId,
      schemaHash: jiandaoyunSchemaHash(selectedWidgets),
      projectionFields: projection.length,
      sourceRows: records.length,
      deletedRows: records.reduce((sum, record) =>
        sum + (populated(record.deleteTime ?? record.delete_time) ? 1 : 0), 0),
      createdFrom: created.minimum,
      updatedThrough: updated.maximum,
      ageDays: updatedMaximum === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - updatedMaximum) / 86_400_000)),
      fieldCoverage: coverage(topRows, contract.fields),
      subforms: (contract.subforms ?? []).map((subform) => {
        const rows = subformRows(records, subform.source);
        return {
          target: subform.target,
          rows: rows.length,
          fieldCoverage: coverage(rows, subform.items),
        };
      }),
    });
  }
  return results;
}
