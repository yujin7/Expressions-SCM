import { and, arrayOverlaps, count, eq, ilike, ne, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/db/schema";
import { getDbAsync } from "@/db";
import { ROLE_LABELS } from "@/server/core/constants";
import { parseSelectedValues, selectedOptionsPredicate } from "@/server/core/selected-options";
import type { AnyDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";

const integer = (max: number) => z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(max));
const querySchema = z.object({ q: z.string().trim().max(200).refine(v => !v.includes("\0")).default(""),
  page: integer(1000000).default("1"), pageSize: integer(50).default("50"), excludeId: integer(2147483647).optional(),
  selectedValues: z.string().optional(),
}).strict();

/** Current active directory only, same assignment eligibility as before; never expose login/bindings. */
export async function listTodoAssignees(params: URLSearchParams, dbArg?: AnyDb): Promise<{ rows: { id: number; name: string; roles: string[] }[]; total: number }> {
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) throw new ApiError(400, "人员查询参数不能重复");
  const parsed = querySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new ApiError(400, "人员查询无效：搜索最多200字，每页1–50条，页码和人员编号必须为正整数");
  const { q, page, pageSize, excludeId } = parsed.data;
  const selected = parseSelectedValues(params);
  if (selected?.some(v => typeof v !== "number")) throw new ApiError(400, "已选人员必须使用数字ID，不能以姓名认领身份");
  const clauses: (SQL | undefined)[] = [eq(users.active, true), excludeId ? ne(users.id, excludeId) : undefined,
    selectedOptionsPredicate(selected, { id: users.id, text: [] })];
  // Exact hydration is independent of the typed search, but retains current active/exclusion filters.
  if (selected === undefined && q) {
    const numeric = /^#?([1-9]\d*)$/.exec(q);
    const exactId = numeric && Number(numeric[1]) <= 2147483647 ? Number(numeric[1]) : null;
    const roleKeys = Object.entries(ROLE_LABELS).filter(([key, label]) => key.includes(q.toLowerCase()) || label.includes(q)).map(([key]) => key);
    clauses.push(or(ilike(users.name, `%${q.replace(/[\\%_]/g, "\\$&")}%`), exactId ? eq(users.id, exactId) : undefined,
      roleKeys.length ? arrayOverlaps(users.roles, roleKeys) : undefined));
  }
  const db = dbArg ?? await getDbAsync(), where = and(...clauses);
  const [rows, totals] = await Promise.all([
    db.select({ id: users.id, name: users.name, roles: users.roles }).from(users).where(where).orderBy(users.name, users.id)
      .limit(pageSize).offset(selected === undefined ? (page - 1) * pageSize : 0),
    db.select({ n: count() }).from(users).where(where),
  ]);
  return { rows, total: Number(totals[0].n) };
}
