import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JiandaoyunFormContract } from "@/server/integrations/jiandaoyun-contracts";
import type { JiandaoyunFormSummary } from "@/server/integrations/jiandaoyun-sync";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(), config: vi.fn(), actorId: vi.fn(), contracts: vi.fn(), contract: vi.fn(),
  sync: vi.fn(), signal: vi.fn(), velocity: vi.fn(), channel: vi.fn(), identity: vi.fn(), bonded: vi.fn(),
}));
vi.mock("@/server/integrations/jiandaoyun", async (original) => ({
  ...await original<typeof import("@/server/integrations/jiandaoyun")>(),
  jiandaoyunEnabled: mocks.enabled,
  jiandaoyunConfigFromEnv: mocks.config,
  jiandaoyunSyncActorId: mocks.actorId,
}));
vi.mock("@/server/integrations/jiandaoyun-contracts", async (original) => ({
  ...await original<typeof import("@/server/integrations/jiandaoyun-contracts")>(),
  configuredJiandaoyunContracts: mocks.contracts,
  jiandaoyunContract: mocks.contract,
}));
vi.mock("@/server/integrations/jiandaoyun-sync", async (original) => ({
  ...await original<typeof import("@/server/integrations/jiandaoyun-sync")>(),
  syncJiandaoyunForm: mocks.sync,
}));
vi.mock("@/server/modules/report/external-demand-signal", async (original) => ({
  ...await original<typeof import("@/server/modules/report/external-demand-signal")>(),
  refreshJiandaoyunExternalDemandReadModel: mocks.signal,
}));
vi.mock("@/server/modules/report/external-velocity", async (original) => ({
  ...await original<typeof import("@/server/modules/report/external-velocity")>(), refreshExternalVelocity: mocks.velocity,
}));
vi.mock("@/server/modules/report/channel-observation", async (original) => ({
  ...await original<typeof import("@/server/modules/report/channel-observation")>(), refreshChannelObservation: mocks.channel,
}));
vi.mock("@/server/modules/report/platform-sku-identity-gap", async (original) => ({
  ...await original<typeof import("@/server/modules/report/platform-sku-identity-gap")>(), refreshPlatformSkuIdentityGap: mocks.identity,
}));
vi.mock("@/server/modules/report/bonded-outbound", async (original) => ({
  ...await original<typeof import("@/server/modules/report/bonded-outbound")>(), refreshBondedOutbound: mocks.bonded,
}));

import { runJiandaoyunConfiguredFormSyncs, runJiandaoyunContractSync, shouldRefreshJiandaoyunDemandModels } from "@/jobs/sync-jiandaoyun";

const SALES = "tmall-sku-sales-observation";
const BONDED = "bonded-warehouse-order-observation";
const OTHER = "product-master-observation";
const fakeDb = { isolatedOrchestrationFixture: true };
const signal = {
  state: "observation", sourceAsOf: "2026-09-01", crosswalkAsOf: "2026-09-01",
  coverage: { salesRows: 2, mappedIdentities: 1, platformIdentities: 1 },
  decisionBrief: { state: "observation", anchorDate: "2026-09-01", current: { observedDays: 1 }, previous: { observedDays: 1 }, change: {} },
  refundDrivers: { state: "observation", totals: {}, identityCoverage: {}, byShop: [], topContributors: [] },
};
const identity = { state: "observation", totals: { platformSkus: 1, mappedAmountPct: 100, coverableAmountPct: 100, unmappedWithCandidates: 0 } };
const bonded = { state: "observation", sourceAsOf: "2026-09-01", anchorDate: "2026-09-01", batches: 1, totals: { qty30: "1", orders30: 1 }, byWarehouse: [], skuMappedPct: 100 };

function selectContracts(...keys: string[]) {
  const contracts: JiandaoyunFormContract[] = keys.map((key) => ({
    key, label: key, appId: "a".repeat(24), entryId: "b".repeat(24), targetTable: `test_${key}`, fields: [],
  }));
  mocks.contracts.mockReturnValue(contracts);
  mocks.contract.mockImplementation((key: string) => contracts.find((item) => item.key === key));
}

function summary(key: string, replayed = false): JiandaoyunFormSummary {
  return { runId: 1, importJobId: 1, contractKey: key, sourceRows: 2, stagedRows: 2, schemaHash: "fixture", sourceAsOf: "2026-09-01", unresolvedAliases: 0, replayed };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.enabled.mockReturnValue(true);
  mocks.config.mockReturnValue({ apiKey: "test-only", baseUrl: "https://api.jiandaoyun.com/api/v5" });
  mocks.actorId.mockReturnValue(1);
  selectContracts(SALES, OTHER, BONDED);
  mocks.sync.mockImplementation(async (_db: unknown, input: { contract: JiandaoyunFormContract }) => summary(input.contract.key));
  mocks.signal.mockResolvedValue(signal);
  mocks.velocity.mockResolvedValue({});
  mocks.channel.mockResolvedValue({});
  mocks.identity.mockResolvedValue(identity);
  mocks.bonded.mockResolvedValue(bonded);
});

describe("简道云配置同步读模型刷新", () => {
  it("任一相关契约成功即可刷新，不要求部署同时选择所有外部数据流", () => {
    expect(shouldRefreshJiandaoyunDemandModels([
      "tmall-sku-crosswalk-observation",
      "tmall-sku-sales-observation",
      "tmall-sku-refund-observation",
    ])).toBe(true);
    expect(shouldRefreshJiandaoyunDemandModels(["pdd-order-observation"])).toBe(true);
    expect(shouldRefreshJiandaoyunDemandModels(["product-master-observation"])).toBe(false);
  });

  it("执行真实配置编排；成功后分别刷新相关读模型", async () => {
    const result = await runJiandaoyunConfiguredFormSyncs(fakeDb);
    expect(result).toMatchObject({ status: "succeeded", contracts: 3, results: [summary(SALES), summary(OTHER), summary(BONDED)] });
    expect(mocks.sync.mock.calls.map((call) => call[1].contract.key)).toEqual([SALES, OTHER, BONDED]);
    for (const mock of [mocks.signal, mocks.velocity, mocks.channel, mocks.identity, mocks.bonded]) {
      expect(mock).toHaveBeenCalledExactlyOnceWith(fakeDb);
    }
  });

  it.each([SALES, OTHER])("流 %s 失败不阻止后续显式流，总任务仍失败", async (failedKey) => {
    mocks.sync.mockImplementation(async (_db: unknown, input: { contract: JiandaoyunFormContract }) => {
      if (input.contract.key === failedKey) throw new Error("模拟受控拒绝");
      return summary(input.contract.key);
    });
    await expect(runJiandaoyunConfiguredFormSyncs(fakeDb)).rejects.toBeInstanceOf(AggregateError);
    expect(mocks.sync.mock.calls.map((call) => call[1].contract.key)).toEqual([SALES, OTHER, BONDED]);
    expect(mocks.bonded).toHaveBeenCalledExactlyOnceWith(fakeDb);
    expect(mocks.signal).toHaveBeenCalledTimes(failedKey === SALES ? 0 : 1);
  });

  it("始终顺序执行，没有并发扩大外部调用配额", async () => {
    let releaseFirst: (() => void) | undefined;
    mocks.sync.mockImplementation(async (_db: unknown, input: { contract: JiandaoyunFormContract }) => {
      if (input.contract.key === SALES) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return summary(input.contract.key);
    });
    const running = runJiandaoyunConfiguredFormSyncs(fakeDb);
    await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    expect(mocks.signal).not.toHaveBeenCalled();
    releaseFirst!();
    await running;
    expect(mocks.sync.mock.calls.map((call) => call[1].contract.key)).toEqual([SALES, OTHER, BONDED]);
  });

  it("全部流失败也逐流尝试，但不能用配置目录触发读模型刷新", async () => {
    mocks.sync.mockRejectedValue(new Error("模拟拒绝"));
    await expect(runJiandaoyunConfiguredFormSyncs(fakeDb)).rejects.toThrow("成功 0/3 流，失败 3 流");
    expect(mocks.sync).toHaveBeenCalledTimes(3);
    for (const mock of [mocks.signal, mocks.velocity, mocks.channel, mocks.identity, mocks.bonded]) expect(mock).not.toHaveBeenCalled();
  });

  it("仅无关流成功，不刷新失败流所对应的需求模型", async () => {
    selectContracts(SALES, OTHER);
    mocks.sync.mockImplementation(async (_db: unknown, input: { contract: JiandaoyunFormContract }) => {
      if (input.contract.key === SALES) throw new Error("销量流拒绝");
      return summary(input.contract.key);
    });
    await expect(runJiandaoyunConfiguredFormSyncs(fakeDb)).rejects.toBeInstanceOf(AggregateError);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    for (const mock of [mocks.signal, mocks.velocity, mocks.channel, mocks.identity, mocks.bonded]) expect(mock).not.toHaveBeenCalled();
  });

  it.each(["signal", "velocity", "channel", "identity"] as const)("%s 刷新失败不阻断其他缓存和保税观察，但总任务不能报成功", async (key) => {
    mocks[key].mockRejectedValue(new Error("模拟缓存失败"));
    await expect(runJiandaoyunConfiguredFormSyncs(fakeDb)).rejects.toThrow("成功 3/3 流，失败 0 流，刷新失败 1 组");
    expect(mocks.sync).toHaveBeenCalledTimes(3);
    for (const mock of [mocks.signal, mocks.velocity, mocks.channel, mocks.identity, mocks.bonded]) expect(mock).toHaveBeenCalledExactlyOnceWith(fakeDb);
  });

  it("保税刷新失败不撤销已成功同步，失败摘要不泄露上游响应", async () => {
    mocks.bonded.mockRejectedValue(new Error("private-upstream-response"));
    const error = await runJiandaoyunConfiguredFormSyncs(fakeDb).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as Error).message).toContain("bonded-outbound");
    expect((error as Error).message).not.toContain("private-upstream-response");
    expect(mocks.sync).toHaveBeenCalledTimes(3);
    expect(mocks.identity).toHaveBeenCalledExactlyOnceWith(fakeDb);
  });

  it("单流入口复用独立缓存刷新，失败不会再次执行或撤销同步", async () => {
    mocks.signal.mockRejectedValue(new Error("需求缓存不可用"));
    await expect(runJiandaoyunContractSync(fakeDb, SALES)).rejects.toBeInstanceOf(AggregateError);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.velocity).toHaveBeenCalledExactlyOnceWith(fakeDb);
    expect(mocks.channel).toHaveBeenCalledExactlyOnceWith(fakeDb);
    expect(mocks.identity).toHaveBeenCalledExactlyOnceWith(fakeDb);
  });

  it("失败后重试仍委托单流幂等回放，不强制重复写入", async () => {
    mocks.sync.mockImplementation(async (_db: unknown, input: { contract: JiandaoyunFormContract }) => summary(input.contract.key, true));
    const result = await runJiandaoyunConfiguredFormSyncs(fakeDb);
    expect(result).toMatchObject({ status: "succeeded", results: [summary(SALES, true), summary(OTHER, true), summary(BONDED, true)] });
    expect(mocks.sync).toHaveBeenCalledTimes(3);
    expect(mocks.signal).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "config", "actor", "contracts"] as const)("缺少 %s 时仍 skipped，不能调用同步或刷新", async (kind) => {
    if (kind === "disabled") mocks.enabled.mockReturnValue(false);
    if (kind === "config") mocks.config.mockReturnValue(null);
    if (kind === "actor") mocks.actorId.mockReturnValue(null);
    if (kind === "contracts") selectContracts();
    await expect(runJiandaoyunConfiguredFormSyncs(fakeDb)).resolves.toMatchObject({ status: "skipped" });
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.signal).not.toHaveBeenCalled();
    expect(mocks.bonded).not.toHaveBeenCalled();
  });

  it("部分失败经真实手动任务入口落 job_runs.ok=false，不能被包装成恢复成功", async () => {
    const { createTestDb } = await import("../helpers/db");
    const schema = await import("@/db/schema");
    const { runJobManually } = await import("@/server/modules/admin/job-run");
    const { db } = await createTestDb();
    const [admin] = await db.insert(schema.users).values({ name: "同步测试管理员", roles: ["admin"], isApprover: true }).returning();
    mocks.sync.mockImplementation(async (_db: unknown, input: { contract: JiandaoyunFormContract }) => {
      if (input.contract.key === OTHER) throw new Error("模拟单流失败");
      return summary(input.contract.key);
    });
    const result = await runJobManually({ id: admin.id, name: admin.name, roles: ["admin"], isApprover: true }, "sync-jiandaoyun-forms", db);
    expect(result).toMatchObject({ ok: false, summary: null });
    const runs = await db.select().from(schema.jobRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job: "sync-jiandaoyun-forms", ok: false });
    expect(mocks.sync).toHaveBeenCalledTimes(3);
    expect(mocks.signal).toHaveBeenCalledExactlyOnceWith(db);
    expect(mocks.bonded).toHaveBeenCalledExactlyOnceWith(db);
  });
});
