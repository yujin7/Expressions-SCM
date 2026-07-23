import { beforeAll, describe, expect, it } from "vitest";
import { bizDateShanghai, nextDocNo } from "@/server/docflow/doc-no";
import { createTestDb, type TestDb } from "../helpers/db";

describe("取号器 nextDocNo（R8/B5）", () => {
  let db: TestDb;

  beforeAll(async () => {
    ({ db } = await createTestDb());
  });

  it("bizDate 用 Asia/Shanghai：UTC 17:30 已是上海次日", () => {
    expect(bizDateShanghai(new Date("2026-07-23T04:00:00Z"))).toBe("20260723");
    expect(bizDateShanghai(new Date("2026-07-22T17:30:00Z"))).toBe("20260723"); // 上海 01:30
    expect(bizDateShanghai(new Date("2026-07-22T15:30:00Z"))).toBe("20260722"); // 上海 23:30
  });

  it("格式 PO-YYYYMMDD-0001 且顺序递增", async () => {
    const now = new Date("2026-07-23T04:00:00Z");
    const a = await nextDocNo(db, "PO", now);
    const b = await nextDocNo(db, "PO", now);
    const c = await nextDocNo(db, "PO", now);
    expect(a).toBe("PO-20260723-0001");
    expect(b).toBe("PO-20260723-0002");
    expect(c).toBe("PO-20260723-0003");
    expect(a).toMatch(/^PO-\d{8}-\d{4}$/);
  });

  it("20 个并发取号 → 20 个互不重复的号", async () => {
    const now = new Date("2026-07-23T04:00:00Z");
    const nos = await Promise.all(
      Array.from({ length: 20 }, () => nextDocNo(db, "WO", now)),
    );
    expect(new Set(nos).size).toBe(20);
    for (const n of nos) expect(n).toMatch(/^WO-20260723-\d{4}$/);
    const seqs = nos.map((n) => Number(n.slice(-4))).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, k) => k + 1));
  });

  it("不同前缀独立计数", async () => {
    const now = new Date("2026-07-23T04:00:00Z");
    expect(await nextDocNo(db, "BH", now)).toBe("BH-20260723-0001");
    expect(await nextDocNo(db, "JS", now)).toBe("JS-20260723-0001");
    expect(await nextDocNo(db, "BH", now)).toBe("BH-20260723-0002");
  });

  it("不同业务日独立计数（跨日归零）", async () => {
    const d1 = new Date("2026-07-23T04:00:00Z");
    const d2 = new Date("2026-07-24T04:00:00Z");
    await nextDocNo(db, "CT", d1);
    await nextDocNo(db, "CT", d1);
    expect(await nextDocNo(db, "CT", d2)).toBe("CT-20260724-0001");
    expect(await nextDocNo(db, "CT", d1)).toBe("CT-20260723-0003");
  });
});
