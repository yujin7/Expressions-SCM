import { ApiError } from "./common";

/** Only named columns are accepted; ordering never interpolates user SQL. */
export function parseMasterListQuery<K extends string>(url: string, sortKeys: readonly K[], statuses?: readonly string[]) {
  const searchParams = new URL(url).searchParams;
  for (const key of ["q", "page", "pageSize", "sort", "order", "status"]) {
    if (searchParams.getAll(key).length > 1) throw new ApiError(400, `${key} 不能重复传入`);
  }
  const positiveInt = (key: string, fallback: number, max: number) => {
    const raw = searchParams.get(key);
    if (raw == null || raw === "") return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) throw new ApiError(400, `${key} 必须是 1–${max} 的整数`);
    return value;
  };
  const sort = searchParams.get("sort") || sortKeys[0];
  const order = searchParams.get("order") || "asc";
  const status = searchParams.get("status") || undefined;
  if (!sortKeys.includes(sort as K)) throw new ApiError(400, "不支持的排序字段");
  if (order !== "asc" && order !== "desc") throw new ApiError(400, "排序方向必须是 asc 或 desc");
  if (status && !statuses?.includes(status)) throw new ApiError(400, "不支持的状态筛选");
  return { q: (searchParams.get("q") ?? "").trim(), page: positiveInt("page", 1, 10_000_000),
    pageSize: positiveInt("pageSize", 20, 999), searchParams, sort: sort as K, order: order as "asc" | "desc", status };
}
