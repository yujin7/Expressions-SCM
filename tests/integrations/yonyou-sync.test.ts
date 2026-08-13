/**
 * 用友只读观测同步测试。
 *
 * 该模块**刻意不做字段映射**：落地时 8 条契约在控制台全部未授权（310037），
 * 从未见过真实响应结构，凭想象写解析器就是把猜测伪装成实现。
 * 所以测试钉的是"不猜也要正确"的那部分：
 *   - 未授权是正常中间态，不抛错、不推进 checkpoint、如实标记；
 *   - 认不出分页结构时**整包原样落库**，绝不丢数据；
 *   - 原始字段一字不改地保留（将来写映射的依据）；
 *   - 幂等重放不重复外呼。
 */
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { YonyouClient } from "@/server/integrations/yonyou-client";
import type { YonyouOpenApiConfig } from "@/server/integrations/yonyou";
import {
  extractRecordArray,
  profileYonyouFields,
  syncYonyouContract,
  yonyouShapeFingerprint,
} from "@/server/integrations/yonyou-sync";
import { loadStagedRows } from "@/server/modules/release/engine/common";
import { createTestDb } from "../helpers/db";

const CONFIG: YonyouOpenApiConfig = {
  appKey: "k", appSecret: "s", tenantId: "t", orgId: "o",
  productProfile: "c4",
  approvedApiContracts: ["物料档案分页查询 V2", "存货成本查询"],
  allowedHosts: ["c4.yonyoucloud.com"],
  baseUrl: "https://c4.yonyoucloud.com/iuap-api-gateway",
  tokenUrl: "https://c4.yonyoucloud.com/iuap-api-gateway/open-auth/selfAppAuth/getAccessToken",
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

const TOKEN_OK = { code: "00000", data: { expire: 7200, access_token: "tok" } };

function clientReturning(bizBody: unknown) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input).includes("getAccessToken")) return json(TOKEN_OK);
    return json(bizBody);
  });
  return {
    // 注入 DNS 桩：出站防重绑守卫会真的解析域名，不注入的话挂 VPN/断网时
    // 每条用例卡满 30 秒超时（本轮实测 4/4 失败）。地址须是真公网段。
    client: new YonyouClient(CONFIG, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      retries: 0,
      dnsLookup: async () => [{ address: "121.199.0.1", family: 4 }],
    }),
    fetchMock,
  };
}

async function seedActor() {
  const { db } = await createTestDb();
  const [user] = await db.insert(schema.users).values({
    username: "yy_sync", name: "用友同步", passwordHash: "x", active: true,
  }).returning();
  return { db, actorId: user.id };
}

describe("用友只读观测同步", () => {
  it("正常响应：原样落 staging，写 run/checkpoint 与证据哈希", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({
      code: "00000",
      data: { recordList: [{ code: "M001", name: "物料甲" }, { code: "M002", name: "物料乙" }] },
    });

    const summary = await syncYonyouContract(db, {
      client, contract: "物料档案分页查询 V2", actorId, scopeKey: "2026-08-04",
    });

    expect(summary.blockedByConsoleGrant).toBe(false);
    expect(summary.sourceRows).toBe(2);
    expect(summary.stagedRows).toBe(2);
    expect(summary.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.importJobId).not.toBeNull();

    const rows = await db.select().from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, summary.importJobId!));
    expect(rows).toHaveLength(2);
    // 原始字段一字不改——将来写映射要靠它
    expect((rows[0].payload as { raw: unknown }).raw).toEqual({ code: "M001", name: "物料甲" });

    const [checkpoint] = await db.select().from(schema.integrationCheckpoints)
      .where(eq(schema.integrationCheckpoints.connector, "yy"));
    expect(checkpoint.cursor).toBe("2026-08-04");

    const [run] = await db.select({ requestScope: schema.integrationRuns.requestScope })
      .from(schema.integrationRuns)
      .where(eq(schema.integrationRuns.id, summary.runId));
    const scope = run.requestScope as { fieldProfile: unknown };
    expect(scope.fieldProfile).toMatchObject({
      version: "yonyou-field-profile/v1",
      totalRecords: 2,
      sampledRecords: 2,
      fieldCount: 2,
      sensitiveFieldCount: 0,
      truncated: false,
    });
    const serializedProfile = JSON.stringify(scope.fieldProfile);
    expect(serializedProfile).not.toContain("M001");
    expect(serializedProfile).not.toContain("物料甲");
  });

  it("310037 未授权：不抛错、不推进 checkpoint、如实标记等待控制台授权", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({
      code: "310037", message: "API未被授权：APPKEY[x]未获得要调用的API[/y]的授权",
    });

    const summary = await syncYonyouContract(db, {
      client, contract: "存货成本查询", actorId, scopeKey: "2026-08-04",
    });

    expect(summary.blockedByConsoleGrant, "等授权是正常中间态，不该当故障").toBe(true);
    expect(summary.stagedRows).toBe(0);
    expect(summary.importJobId).toBeNull();

    const checkpoints = await db.select().from(schema.integrationCheckpoints)
      .where(eq(schema.integrationCheckpoints.connector, "yy"));
    expect(checkpoints, "未取到数据不得推进 checkpoint").toHaveLength(0);
  });

  it("认不出分页结构时整包原样落一行，绝不丢数据", async () => {
    const { db, actorId } = await seedActor();
    // 用友各接口外层结构不一，这里给一个我们没见过的形状
    const { client } = clientReturning({
      code: "00000",
      data: { 某个未知包裹: { 明细: [{ a: 1 }] }, total: 1 },
    });

    const summary = await syncYonyouContract(db, {
      client, contract: "存货成本查询", actorId, scopeKey: "unknown-shape",
    });

    expect(summary.stagedRows).toBe(1);
    const rows = await db.select().from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, summary.importJobId!));
    expect((rows[0].payload as { raw: Record<string, unknown> }).raw).toHaveProperty("某个未知包裹");
  });

  it("同 scopeKey 重放直接返回上次结果，不重复外呼", async () => {
    const { db, actorId } = await seedActor();
    const { client, fetchMock } = clientReturning({
      code: "00000", data: { rows: [{ code: "M001" }] },
    });

    await syncYonyouContract(db, {
      client, contract: "物料档案分页查询 V2", actorId, scopeKey: "same-key",
    });
    const callsAfterFirst = fetchMock.mock.calls.length;

    const replay = await syncYonyouContract(db, {
      client, contract: "物料档案分页查询 V2", actorId, scopeKey: "same-key",
    });

    expect(replay.replayed).toBe(true);
    expect(fetchMock.mock.calls.length, "重放不应再打接口").toBe(callsAfterFirst);
  });

  it("结构漂移持续阻断放行，连续返回同一新结构也不会自动建立新基线", async () => {
    const { db, actorId } = await seedActor();
    const baselineClient = clientReturning({
      code: "00000", data: { rows: [{ code: "M001", name: "物料甲" }] },
    }).client;
    const sameShapeClient = clientReturning({
      code: "00000", data: { rows: [{ code: "M002", name: "物料乙" }] },
    }).client;
    const changedClient = clientReturning({
      code: "00000", data: { rows: [{ code: "M003", name: "物料丙", mobile: "13800000000" }] },
    }).client;

    const baseline = await syncYonyouContract(db, {
      client: baselineClient, contract: "物料档案分页查询 V2", actorId, scopeKey: "baseline",
    });
    expect(baseline).toMatchObject({ schemaDrift: false, releaseBlocked: false });

    const stable = await syncYonyouContract(db, {
      client: sameShapeClient, contract: "物料档案分页查询 V2", actorId, scopeKey: "stable",
    });
    expect(stable).toMatchObject({ schemaDrift: false, releaseBlocked: false });

    const drift = await syncYonyouContract(db, {
      client: changedClient, contract: "物料档案分页查询 V2", actorId, scopeKey: "drift-1",
    });
    expect(drift).toMatchObject({ schemaDrift: true, releaseBlocked: true });
    expect(drift.importJobId).not.toBeNull();

    const [job] = await db.select({ scope: schema.importJobs.scope })
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, drift.importJobId!));
    expect(job.scope).toMatchObject({
      schemaVersion: "yonyou-observation-v1",
      schemaDrift: true,
      schemaBaselineRunId: stable.runId,
      releaseBlocked: true,
    });
    await expect(loadStagedRows(db, "yonyou_observation", [drift.importJobId!]))
      .rejects.toThrow(/releaseBlocked，禁止进入正式放行引擎/);

    const stillDrift = await syncYonyouContract(db, {
      client: changedClient, contract: "物料档案分页查询 V2", actorId, scopeKey: "drift-2",
    });
    expect(stillDrift).toMatchObject({ schemaDrift: true, releaseBlocked: true });
    const replay = await syncYonyouContract(db, {
      client: changedClient, contract: "物料档案分页查询 V2", actorId, scopeKey: "drift-1",
    });
    expect(replay).toMatchObject({ replayed: true, schemaDrift: true, releaseBlocked: true });
    expect(replay.shapeFingerprint).toBe(drift.shapeFingerprint);
  });

  it("未批准的契约拒绝同步（双重白名单的第二道）", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({ code: "00000", data: {} });

    await expect(syncYonyouContract(db, {
      client, contract: "凭证列表查询", actorId, scopeKey: "x",
    })).rejects.toThrow(/不在 YY_APPROVED_API_CONTRACTS 批准范围内/);
  });

  it("执行人不存在时拒绝同步（审计要有真实归属）", async () => {
    const { db } = await seedActor();
    const { client } = clientReturning({ code: "00000", data: {} });

    await expect(syncYonyouContract(db, {
      client, contract: "存货成本查询", actorId: 99999, scopeKey: "x",
    })).rejects.toThrow(/执行人 99999 不存在/);
  });
});

describe("响应结构工具", () => {
  it("结构指纹只看键的形状，与具体值无关", () => {
    const a = yonyouShapeFingerprint({ code: "M001", qty: 1 });
    const b = yonyouShapeFingerprint({ code: "M999", qty: 42 });
    expect(a).toBe(b);
    expect(yonyouShapeFingerprint({ code: "x" })).not.toBe(a);
  });

  it("指纹区分数组与对象，且对空数组不臆断元素结构", () => {
    expect(yonyouShapeFingerprint({ rows: [] })).toBe("{rows:[]}");
    expect(yonyouShapeFingerprint({ rows: [{ a: 1 }] })).toBe("{rows:[{a:number}]}");
  });

  it("结构指纹联合数组内不同形状，且不受记录顺序影响", () => {
    const a = yonyouShapeFingerprint({ rows: [{ code: "M1" }, { code: "M2", name: "物料" }] });
    const b = yonyouShapeFingerprint({ rows: [{ code: "M2", name: "另一物料" }, { code: "M1" }] });
    expect(a).toBe(b);
    expect(a).toContain("{code:string,name:string}");
    expect(a).toContain("{code:string}");
  });

  it("字段画像只保留路径/类型/出现率与敏感分类，不复制业务值", () => {
    const profile = profileYonyouFields([
      {
        code: "M001",
        mobile: "13800000000",
        bankAccount: "6222000000000000",
        lines: [{ qty: 1 }],
      },
      {
        code: "M002",
        mobile: null,
        lines: [{ qty: "2", remark: "内部备注" }],
      },
    ]);

    expect(profile).toMatchObject({
      version: "yonyou-field-profile/v1",
      totalRecords: 2,
      sampledRecords: 2,
      sensitiveFieldCount: 2,
      sensitiveCategories: ["contact", "financial"],
      truncated: false,
    });
    expect(profile.fields.find((field) => field.path === "bankAccount")).toMatchObject({
      types: ["string"],
      presentInRecords: 1,
      optional: true,
      nullable: false,
      sensitiveCategory: "financial",
    });
    expect(profile.fields.find((field) => field.path === "mobile")).toMatchObject({
      types: ["null", "string"],
      presentInRecords: 2,
      optional: false,
      nullable: true,
      sensitiveCategory: "contact",
    });
    expect(profile.fields.find((field) => field.path === "lines[].remark")).toMatchObject({
      presentInRecords: 1,
      optional: true,
    });
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain("13800000000");
    expect(serialized).not.toContain("6222000000000000");
    expect(serialized).not.toContain("内部备注");
  });

  it("字段画像有字段数上限，异常宽响应不会撑大运行元数据", () => {
    const record = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`field_${index}`, index]));
    const profile = profileYonyouFields([record]);
    expect(profile.fieldCount).toBe(256);
    expect(profile.truncated).toBe(true);
  });

  it("能在常见包裹键下找到记录数组", () => {
    expect(extractRecordArray({ recordList: [1, 2] })).toEqual([1, 2]);
    expect(extractRecordArray({ data: { rows: [3] } })).toEqual([3]);
  });

  it("认不出就返回 null，不硬凑", () => {
    expect(extractRecordArray({ 未知: { 更深: { rows: [1] } } })).toBeNull();
    expect(extractRecordArray({ total: 5 })).toBeNull();
  });
});
