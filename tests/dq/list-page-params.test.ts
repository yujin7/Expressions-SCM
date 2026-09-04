/**
 * 安全审计 S6：`?page=x` 曾经把 NaN 绑进 LIMIT/OFFSET。
 *
 * 路由写的是 `page: Number(params.get("page") ?? 1)`，服务层写的是 `Math.max(1, query.page ?? 1)`——
 * 而 `Math.max(1, NaN)` **仍然是 NaN**（?? 也拦不住，NaN 不是 null）。于是任何一个手敲/爬虫来的
 * 非数字 page 都能让这两条清单 500，并且每次都往 error_logs 里写一条：一个未认证复杂度极低的
 * 噪声/日志膨胀入口。修法：路由改用仓库既有的 parseListQuery（`Number(...) || 1`），
 * service 再自守一道（任务/测试也可能直调）。
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { listBelowFloor, listManualOverrides } from "@/server/modules/dq/lists";
import { createTestDb, type TestDb } from "../helpers/db";

const mocks = vi.hoisted(() => ({ db: null as unknown, guardFreshWrite: vi.fn() }));
vi.mock("@/db", () => ({ getDbAsync: vi.fn(async () => mocks.db) }));
vi.mock("@/server/modules/outsource/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/outsource/common")>();
  return { ...original, guardFreshWrite: mocks.guardFreshWrite };
});

const { GET: belowFloorGet } = await import("@/app/api/report/data-quality/below-floor/route");
const { GET: overridesGet } = await import("@/app/api/report/data-quality/manual-overrides/route");

const pmc: SessionUser = { id: 1, name: "计划", roles: ["pmc"], isApprover: false };

let db: TestDb;
beforeEach(async () => {
  ({ db } = await createTestDb());
  mocks.db = db;
  mocks.guardFreshWrite.mockResolvedValue(pmc);
});

const SURFACES = [
  { name: "below-floor", get: (qs: string) => belowFloorGet(new NextRequest(`http://localhost/api/report/data-quality/below-floor${qs}`)) },
  { name: "manual-overrides", get: (qs: string) => overridesGet(new NextRequest(`http://localhost/api/report/data-quality/manual-overrides${qs}`)) },
];

describe("S6 数据质量清单：非法分页参数不再 500", () => {
  for (const s of SURFACES) {
    it(`${s.name}：?page=x / ?pageSize=x / 负数 / 超大 都返回 200 且分页归一`, async () => {
      for (const qs of ["?page=x", "?page=x&pageSize=y", "?page=-3", "?page=0", "?pageSize=99999", "?page=1e999"]) {
        const res = await s.get(qs);
        expect(res.status, qs).toBe(200);
        const body = (await res.json()) as { page: number; pageSize: number };
        expect(Number.isFinite(body.page), qs).toBe(true);
        expect(body.page, qs).toBeGreaterThanOrEqual(1);
        expect(body.pageSize, qs).toBeGreaterThanOrEqual(1);
        expect(body.pageSize, qs).toBeLessThanOrEqual(200);
      }
      // 500 不会发生，也就不会有 error_logs 噪声
      expect(await db.select().from(schema.errorLogs)).toHaveLength(0);
    });
  }

  it("service 层自守：直接传 NaN / Infinity / 负数也不会绑进 LIMIT/OFFSET", async () => {
    for (const bad of [NaN, Infinity, -1, 0]) {
      await expect(listBelowFloor(db, { page: bad, pageSize: bad })).resolves.toMatchObject({ page: expect.any(Number) });
      const r = await listManualOverrides(db, { page: bad, pageSize: bad }, pmc.roles);
      expect(Number.isFinite(r.page)).toBe(true);
      expect(r.page).toBeGreaterThanOrEqual(1);
      expect(r.pageSize).toBeGreaterThanOrEqual(1);
    }
  });
});
