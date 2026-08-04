/**
 * 聚水潭仓库可信范围。
 *
 * 业务事实（2026-08-04）：聚水潭里**只有「一仓」的数据是准的，其余仓不准**。
 *
 * 要钉住的是两个流的粒度差异：出库单逐单带仓库、可过滤；
 * 库存接口不带 wms_co_id 时返回**全仓合计**，把准仓和不准仓加在一起且拆不开——
 * 那个数字看起来像完整库存总量，实际混着已知错误，比没有数字更危险。
 */
import { describe, expect, it } from "vitest";
import {
  inventoryStreamBlockReason,
  isTrustedWarehouse,
  jstWarehouseTrustFromEnv,
} from "@/server/integrations/jst-warehouse-trust";

const env = (value?: string): NodeJS.ProcessEnv =>
  ({ ...(value === undefined ? {} : { JST_TRUSTED_WMS_CO_IDS: value }) }) as NodeJS.ProcessEnv;

describe("聚水潭仓库可信范围", () => {
  it("解析逗号分隔清单，容忍空格", () => {
    const trust = jstWarehouseTrustFromEnv(env(" 13553853 , 13514384 "));
    expect(trust.declared).toBe(true);
    expect([...trust.trusted].sort()).toEqual(["13514384", "13553853"]);
  });

  it("未声明时 trusted 为空且 declared=false——不能把「没说」当成「都可信」", () => {
    const trust = jstWarehouseTrustFromEnv(env());
    expect(trust.declared).toBe(false);
    expect(trust.trusted.size).toBe(0);
  });

  it("只有清单内的仓算可信；数字与字符串等价", () => {
    const trust = jstWarehouseTrustFromEnv(env("13553853"));
    expect(isTrustedWarehouse("13553853", trust)).toBe(true);
    expect(isTrustedWarehouse(13553853, trust)).toBe(true);
    expect(isTrustedWarehouse("13534943", trust)).toBe(false);
  });

  it("空值一律不可信——缺仓库信息的行不能默认放行", () => {
    const trust = jstWarehouseTrustFromEnv(env("13553853"));
    expect(isTrustedWarehouse(null, trust)).toBe(false);
    expect(isTrustedWarehouse(undefined, trust)).toBe(false);
    expect(isTrustedWarehouse("", trust)).toBe(false);
  });

  it("未声明可信范围时，库存流被拒并说明「未知不等于全部可信」", () => {
    const reason = inventoryStreamBlockReason(jstWarehouseTrustFromEnv(env()));
    expect(reason).toBeTruthy();
    expect(reason).toContain("未知不等于全部可信");
  });

  it("已声明可信范围时，库存流仍被拒——全仓合计混入不准仓且拆不开", () => {
    const reason = inventoryStreamBlockReason(jstWarehouseTrustFromEnv(env("13553853")));
    expect(reason).toBeTruthy();
    expect(reason, "必须点明是全仓合计这个粒度问题").toContain("全仓合计");
    expect(reason, "必须点明比没有数字更危险").toContain("比没有数字更危险");
    expect(reason).toContain("13553853");
  });

  it("显式声明 ALL（全部仓都准）才放行库存流——这是唯一的合法出口", () => {
    const trust = jstWarehouseTrustFromEnv(env("ALL"));
    expect(trust.allTrusted).toBe(true);
    expect(inventoryStreamBlockReason(trust)).toBeNull();
    // ALL 之下任何仓都算可信
    expect(isTrustedWarehouse("13534943", trust)).toBe(true);
    expect(isTrustedWarehouse(null, trust), "空值仍不可信").toBe(false);
  });

  it("拒绝理由要指出出路是逐仓拉取，而不是让人去改配置绕过", () => {
    const reason = inventoryStreamBlockReason(jstWarehouseTrustFromEnv(env("13553853")))!;
    expect(reason).toContain("逐仓拉取");
  });
});
