import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConnectorUnlockGuidance } from "@/app/(app)/admin/health/health-client";
import { adminConnectorReadiness } from "@/server/modules/admin/health";
import { getConnectorReadiness } from "@/server/integrations/connector";
import { YONYOU_READ_CONTRACTS } from "@/server/integrations/yonyou-contracts";
import type { OpsHealth } from "@/server/modules/admin/health";

const NOW = new Date("2026-09-06T03:00:00Z");
const YY_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test", YY_APP_KEY: "synthetic-guidance-app", YY_APP_SECRET: "synthetic-guidance-secret",
  YY_TENANT_ID: "synthetic-tenant", YY_ORG_ID: "synthetic-org", YY_PRODUCT_PROFILE: "yonbip",
  YY_APPROVED_API_CONTRACTS: YONYOU_READ_CONTRACTS[0].name,
  YY_ALLOWED_HOSTS: "api.yonyoucloud.com,auth.yonyoucloud.com",
  YY_BASE_URL: "https://api.yonyoucloud.com", YY_TOKEN_URL: "https://auth.yonyoucloud.com/token",
};
const CONFIGURED: Record<string, NodeJS.ProcessEnv> = {
  yy: YY_ENV,
  jdy: { NODE_ENV: "test", JIANDAOYUN_API_KEY: "synthetic-guidance-key", JIANDAOYUN_SYNC_ACTOR_ID: "2", JIANDAOYUN_SYNC_CONTRACTS: "product-master-observation" },
  jst: { NODE_ENV: "test", JST_APP_KEY: "synthetic-guidance-app", JST_APP_SECRET: "synthetic-guidance-secret", JST_ACCESS_TOKEN: "synthetic-guidance-token", JST_SYNC_ACTOR_ID: "2" },
  feishu: { NODE_ENV: "test", FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-guidance" },
};

function connector(key: string, env: NodeJS.ProcessEnv = { NODE_ENV: "test" }) {
  const rows = getConnectorReadiness(env, NOW);
  const result = adminConnectorReadiness(rows).find((row) => row.key === key);
  if (!result) throw new Error("Synthetic connector missing");
  return result;
}
const render = (row: OpsHealth["connectors"][number]) => renderToStaticMarkup(createElement(ConnectorUnlockGuidance, { connector: row }));
function steps(html: string): string[] {
  const list = html.match(/<ol\b[^>]*>([\s\S]*?)<\/ol>/)?.[1] ?? "";
  return [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((match) => match[1].replace(/<[^>]+>/g, ""));
}

describe("connector recovery guidance uses one ordered, evidence-safe path", () => {
  it.each(["yy", "jdy", "jst", "feishu"])("%s missing configuration is the first rendered action, never replaced by API names", (key) => {
    const row = connector(key);
    expect(row.configured).toBe(false);
    const html = render(row);
    const actions = steps(html);
    expect(actions[0]).toContain("先补齐系统列出的缺失配置");
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions.length).toBeLessThanOrEqual(7);
    expect(html).toContain("核对与恢复");
    expect(html).toContain("打开官方后台");
    expect(html).not.toContain("即可立刻放行");
    expect(html).not.toContain("synthetic-guidance-secret");
  });

  it.each(["yy", "jdy", "jst", "feishu"])("%s configured guidance retains only relevant recovery and acceptance steps", (key) => {
    const row = connector(key, CONFIGURED[key]);
    expect(row.configured).toBe(true);
    expect(row.operational).toBe(false);
    const html = render(row);
    const actions = steps(html);
    expect(actions.join(" ")).not.toContain("先补齐");
    expect(actions.join(" ")).toContain("UAT");
    expect(actions.length).toBeLessThanOrEqual(5);
    expect(html).not.toContain("synthetic-guidance-secret");
    expect(html).not.toContain("synthetic-guidance-token");
    if (key !== "feishu") {
      expect(actions.join(" ")).toContain("控制总量");
      expect(actions.join(" ")).toMatch(/身份|映射/);
    }
  });

  it("admin enrichment keeps generic steps intact and places exact Yonyou names only in a collapsed catalog", () => {
    const generic = getConnectorReadiness({ NODE_ENV: "test" }, NOW);
    const before = JSON.stringify(generic);
    const admin = adminConnectorReadiness(generic);
    expect(JSON.stringify(generic)).toBe(before);
    const yy = admin.find((row) => row.key === "yy")!;
    expect(yy.remediationSteps).toEqual(generic.find((row) => row.key === "yy")!.remediationSteps);
    expect(yy.readOnlyApiCatalog).toEqual(YONYOU_READ_CONTRACTS.map((contract) => contract.name));
    expect(admin.filter((row) => row.key !== "yy").every((row) => row.readOnlyApiCatalog === undefined)).toBe(true);
    const html = render(yy);
    const actions = steps(html);
    expect(actions.filter((step) => step.includes("API 权限"))).toHaveLength(1);
    expect(actions.join(" ")).toContain("不要求全选或全部授权");
    expect(html).toContain(`查看代码白名单（${YONYOU_READ_CONTRACTS.length} 项只读 API）`);
    expect(html).toMatch(/<details\b/);
    expect(html).not.toMatch(/<details\b[^>]*\bopen(?:[\s=>])/);
    expect(html).toContain("不是当前已选或已授权清单");
    for (const contract of YONYOU_READ_CONTRACTS) {
      expect(JSON.stringify(generic)).not.toContain(contract.name);
      expect(actions.join(" ")).not.toContain(contract.name);
      expect(html.split(contract.name)).toHaveLength(2);
    }
  });

  it.each([1, YONYOU_READ_CONTRACTS.length])("selected %i contracts means configuration, not a demand to grant the whole catalog", (count) => {
    const html = render(connector("yy", { ...YY_ENV, YY_APPROVED_API_CONTRACTS: YONYOU_READ_CONTRACTS.slice(0, count).map((contract) => contract.name).join(",") }));
    expect(html).toContain(`当前配置已选 ${count} 项`);
    expect(html).toContain("选择不等于权限已获批、读取成功或 UAT 通过");
    expect(steps(html).join(" ")).not.toContain("当前尚未选择");
    expect(html).not.toContain("逐条授权 8 项");
  });

  it.each(["", "unsupported-contract"])("missing/invalid selection %s is addressed before permission checks or reads", (selection) => {
    const html = render(connector("yy", { ...YY_ENV, YY_APPROVED_API_CONTRACTS: selection }));
    const actions = steps(html);
    expect(actions[0]).toContain("先补齐");
    expect(actions[1]).toContain(selection ? "契约选择无效" : "尚未选择同步契约");
    expect(actions[2]).toContain("API 权限");
    expect(html).toContain("当前未形成有效选择");
  });

  it.each(["yy", "jdy"])("%s enablement guidance follows existing state without silently changing it", (key) => {
    const setting = key === "yy" ? "YY_SYNC_ENABLED" : "JIANDAOYUN_SYNC_ENABLED";
    for (const value of ["false", "true", "invalid"]) {
      const row = connector(key, { ...CONFIGURED[key], [setting]: value });
      const before = JSON.stringify(row);
      const actions = steps(render(row));
      expect(JSON.stringify(row)).toBe(before);
      if (value === "false") expect(actions.at(-1)).toContain("当前同步保持关闭");
      else if (value === "invalid") expect(actions.at(-1)).toContain("同步启用标记无效");
      else expect(actions.join(" ")).not.toMatch(/保持关闭|启用标记无效/);
      expect(row.operational).toBe(false);
    }
  });

  it("provider-specific boundaries remain useful without manufacturing success", () => {
    const jst = steps(render(connector("jst", CONFIGURED.jst))).join(" ");
    expect(jst).toContain("固定出口 IP");
    expect(jst).toContain("平台专用授权");
    expect(jst).toContain("不直接写库存账");
    const jdy = steps(render(connector("jdy", CONFIGURED.jdy))).join(" ");
    expect(jdy).toContain("区分全量和滚动窗口");
    expect(jdy).toContain("父任务失败不代表所有流停摆");
    expect(jdy).toContain("删除签认不绕过完整性守卫");
    const feishu = steps(render(connector("feishu", CONFIGURED.feishu))).join(" ");
    expect(feishu).toContain("SCM 通知最小权限");
    expect(feishu).toContain("送达不等于已读或业务处置完成");
    expect(feishu).not.toContain("全部授权");
  });

  it("a deletion acknowledgement success message cannot promise immediate release", () => {
    const source = readFileSync("src/app/(app)/admin/health/health-client.tsx", "utf8");
    const notification = source.match(/message\.success\("已登记删除[^\n]+/)?.[0];
    expect(notification).toBeDefined();
    expect(notification).toContain("不代表批次已放行");
    expect(notification).toContain("回源与提取完整性核对");
    expect(notification).toContain("截断等守卫仍生效");
    expect(notification).not.toMatch(/即可|立刻放行|不必等下一轮/);
  });
});
