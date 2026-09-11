import { inArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { ApiError } from "@/server/modules/master/common";

export type SelectedOptionValue = number | string;
export const SELECTED_OPTIONS_LIMIT = 200;

/** Optional exact-option lookup; missing and an explicit empty selection are different requests. */
export function parseSelectedValues(params: URLSearchParams): SelectedOptionValue[] | undefined {
  const raw = params.getAll("selectedValues");
  if (raw.length === 0) return undefined;
  if (raw.length !== 1) throw new ApiError(400, "selectedValues 不能重复传入");
  let values: unknown;
  try {
    values = JSON.parse(raw[0]);
  } catch {
    throw new ApiError(400, "selectedValues 必须是 JSON 数组");
  }
  if (!Array.isArray(values) || values.length > 50) {
    throw new ApiError(400, "selectedValues 必须是最多 50 项的数组");
  }
  for (const value of values) {
    if (typeof value === "number") {
      if (Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647) continue;
    } else if (typeof value === "string") {
      if (value.trim().length > 0 && value.length <= 200 && !value.includes("\0")) continue;
    }
    throw new ApiError(400, "selectedValues 仅支持有效的正整数 ID 或 1–200 字符的非空字符串");
  }
  return values as SelectedOptionValue[];
}

/**
 * Number values match IDs; strings match only the domain's existing code/name fields.
 * Values remain SQL parameters, never SQL text, fuzzy aliases, or identity claims.
 * Callers intersect this predicate with every existing filter and retain an honest total.
 */
export function selectedOptionsPredicate(
  values: readonly SelectedOptionValue[] | undefined,
  columns: { id: AnyColumn; text: readonly AnyColumn[] },
): SQL | undefined {
  if (values === undefined) return undefined;
  if (values.length === 0) return sql`false`;
  const ids = values.filter((value): value is number => typeof value === "number");
  const strings = values.filter((value): value is string => typeof value === "string");
  const predicates: SQL[] = [];
  if (ids.length) predicates.push(inArray(columns.id, ids));
  if (strings.length) {
    predicates.push(...columns.text.map((column) => inArray(column, strings)));
  }
  return predicates.length ? or(...predicates) : sql`false`;
}
