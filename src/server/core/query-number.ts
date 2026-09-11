import { ApiError } from "@/server/modules/master/common";

/** Only an omitted parameter means "use the default"; malformed filters must not broaden a report. */
export function optionalIntegerQuery(
  params: URLSearchParams,
  key: string,
  { label, min = 1, max = 2_147_483_647 }: { label: string; min?: number; max?: number },
): number | undefined {
  const values = params.getAll(key);
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new ApiError(400, `${label}不能重复传入`);
  const raw = values[0];
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError(400, `${label}必须是 ${min}–${max} 的整数`);
  }
  return value;
}
