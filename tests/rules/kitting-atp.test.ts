/** E2-09 齐套 ATP-lite 纯规则测试（数量走 decimal 字符串） */
import { describe, expect, it } from "vitest";
import { earliestKitDate, type MaterialNeed } from "@/server/rules/kitting-atp";

const T = "2026-08-01";
const need = (
  id: number,
  required: string,
  onHand: string,
  arrivals: { date: string; qty: string }[] = [],
): MaterialNeed => ({ materialSkuId: id, required, onHand, arrivals });

describe("earliestKitDate", () => {
  it("全部物料当前即满足 → kitDate = today", () => {
    const r = earliestKitDate([need(1, "10", "10"), need(2, "5", "99")], T);
    expect(r.kitDate).toBe(T);
    expect(r.daysToKit).toBe(0);
    expect(r.note).toBe("当前即可齐套");
  });

  it("靠 3 天后到货补齐 → kitDate 为该到货日", () => {
    const r = earliestKitDate([need(1, "100", "40", [{ date: "2026-08-04", qty: "60" }])], T);
    expect(r.kitDate).toBe("2026-08-04");
    expect(r.daysToKit).toBe(3);
  });

  it("木桶效应：多物料取最晚可齐日", () => {
    const r = earliestKitDate(
      [
        need(1, "10", "0", [{ date: "2026-08-02", qty: "10" }]),
        need(2, "10", "0", [{ date: "2026-08-09", qty: "10" }]),
      ],
      T,
    );
    expect(r.kitDate).toBe("2026-08-09");
    expect(r.daysToKit).toBe(8);
    expect(r.note).toContain("最晚到料");
  });

  it("视野内不足 → kitDate=null 且 blockers 给出缺口", () => {
    const r = earliestKitDate([need(7, "100", "10", [{ date: "2026-08-05", qty: "20" }])], T, 30);
    expect(r.kitDate).toBeNull();
    expect(r.daysToKit).toBeNull();
    expect(r.blockers).toHaveLength(1);
    expect(r.blockers[0].materialSkuId).toBe(7);
    expect(r.blockers[0].shortBy).toBe("70.0000");
  });

  it("**小数量刚好凑够也判为齐套**（浮点会把 0.1+0.2 判成不够）", () => {
    const r = earliestKitDate(
      [need(1, "0.3", "0.1", [{ date: "2026-08-02", qty: "0.2" }])],
      T,
    );
    expect(r.kitDate).toBe("2026-08-02");
    expect(r.blockers).toEqual([]);
  });

  it("空 needs → today，且 note 澄清这不是「已验证齐套」", () => {
    const r = earliestKitDate([], T);
    expect(r.kitDate).toBe(T);
    expect(r.note).toContain("非");
  });

  it("视野外的到货不参与推演", () => {
    const r = earliestKitDate([need(1, "50", "0", [{ date: "2027-01-01", qty: "99" }])], T, 30);
    expect(r.kitDate).toBeNull();
    expect(r.blockers[0].shortBy).toBe("50.0000");
  });

  it("早于今天的到货并入今天（已在途即将入仓）", () => {
    const r = earliestKitDate([need(1, "50", "0", [{ date: "2026-07-01", qty: "50" }])], T);
    expect(r.kitDate).toBe(T);
  });

  it("同日多批到货累加", () => {
    const r = earliestKitDate(
      [need(1, "100", "0", [{ date: "2026-08-03", qty: "40" }, { date: "2026-08-03", qty: "60" }])],
      T,
    );
    expect(r.kitDate).toBe("2026-08-03");
  });

  it("qty<=0 的到货被忽略", () => {
    const r = earliestKitDate(
      [need(1, "10", "0", [{ date: "2026-08-02", qty: "0" }, { date: "2026-08-05", qty: "10" }])],
      T,
    );
    expect(r.kitDate).toBe("2026-08-05");
  });

  it("部分物料缺料 → 整单 null（不因其他物料已齐就乐观）", () => {
    const r = earliestKitDate([need(1, "10", "10"), need(2, "99", "0")], T, 10);
    expect(r.kitDate).toBeNull();
    expect(r.perMaterial[0].readyDate).toBe(T); // 逐料明细仍如实给出
    expect(r.perMaterial[1].readyDate).toBeNull();
  });

  it("**非法数量字符串不抛错**（脏数据不得炸掉排产推演）", () => {
    expect(() => earliestKitDate([need(1, "abc", "xyz")], T)).not.toThrow();
    const r = earliestKitDate([need(1, "10", "bad", [{ date: "2026-08-02", qty: "oops" }])], T, 5);
    expect(r.kitDate).toBeNull(); // 脏值按 0 处理 → 如实报缺，不假装齐套
    expect(r.blockers[0].shortBy).toBe("10.0000");
  });
});
