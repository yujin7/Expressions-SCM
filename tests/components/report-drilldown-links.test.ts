/**
 * 报表数字不是死胡同：每个能追问「这是从哪来的」的数字都要能点过去。
 *
 * 事故背景（2026-09-04 审计）：
 * - `/report/funnel` 五级漏斗全是纯文本，看到「下单 12,300」没有任何入口去看那批工单；
 * - `/report/wip` 的 JG / 工单单号是纯文本，抄下来再去列表里搜；
 * - `/report/sku-360` 既没有来源/截至说明（不知道数据多新、涵盖哪四张表），
 *   时间轴事件也点不动（「出库 sh #12」里的 #12 对人毫无意义）；
 * - `/report/demand` 的渠道下拉硬编码九个渠道名，主数据加一个渠道这里永远看不到；
 * - `/report/dashboard` 页面标题自称「经营驾驶舱」，菜单里叫「经营分析总览」，
 *   而系统里同时还有另一个「驾驶舱四屏」——三个驾驶舱互相打架。
 *
 * 回链的**过滤条件必须进 URL**，并且目标列表要真的消费它（BH/WO/SH 的 from/to）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_REGISTRY } from "@/lib/route-access";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("报表回链与来源标注", () => {
  it("全链漏斗：五级数字各自带链接，计划/下单/到货携带制单时间窗", () => {
    const src = read("src/app/(app)/report/funnel/funnel-client.tsx");
    expect(src).toContain("function stageHref");
    expect(src).toContain('case "plan": return `/outsource/bh?${window}`');
    expect(src).toContain('case "order": return `/outsource/wo?${window}`');
    expect(src).toContain('case "receipt": return `/matflow/sh?${window}`');
    expect(src).toContain('case "demand": return "/report/demand"');
    expect(src).toContain('case "sales": return "/report/dashboard"');
    expect(src).toContain("const window = `from=${from}&to=${to}`");
  });

  it("BH / WO / SH 三张列表真的消费 from/to（否则回链只是换了个 URL）", () => {
    const lists: [string, string][] = [
      ["src/app/(app)/outsource/bh/bh-client.tsx", "/api/outsource/bh"],
      ["src/app/(app)/outsource/wo/wo-client.tsx", "/api/outsource/wo"],
      ["src/app/(app)/matflow/sh/sh-client.tsx", "/api/matflow/sh"],
    ];
    for (const [file, api] of lists) {
      const src = read(file);
      expect(src, file).toContain('from: ""');
      expect(src, file).toContain('to: ""');
      expect(src, file).toContain('if (from) params.set("from", from);');
      expect(src, file).toContain('if (to) params.set("to", to);');
      expect(src, file).toContain(api);
      // 窗口生效时必须可见且可清除，否则用户只看到「行数莫名变少」
      expect(src, file).toContain("DocWindowFilterTag");
    }
    // 后端三条 list 服务共用同一条时间窗口径
    for (const svc of [
      "src/server/modules/outsource/bh.ts",
      "src/server/modules/outsource/wo.ts",
      "src/server/modules/matflow/sh-read.ts",
    ]) {
      expect(read(svc), svc).toContain("createdWithinShanghaiDays");
    }
  });

  it("委外在制看板：JG / 工单单号回链到各自列表", () => {
    const src = read("src/app/(app)/report/wip/wip-client.tsx");
    expect(src).toContain("`/outsource/jg?q=${encodeURIComponent(r.jgNo)}`");
    expect(src).toContain("`/outsource/wo?q=${encodeURIComponent(v)}`");
  });

  it("SKU 360：有来源/截至芯片，事件带 href 回链来源单据或来源列表", () => {
    const client = read("src/app/(app)/report/sku-360/sku-360-client.tsx");
    expect(client).toContain("data.sources");
    expect(client).toContain("截至 {data.asOf}");
    expect(client).toContain("e.href ? (");

    const svc = read("src/server/modules/report/sku-timeline.ts");
    // 四源都要报出条数，且服务端负责解析单号（前端拿到的是可点的 href，不是 "sh #12"）
    expect(svc).toContain('key: "stock_ledger"');
    expect(svc).toContain('key: "transit_refs"');
    expect(svc).toContain('key: "batch_stocks"');
    expect(svc).toContain('key: "review_items"');
    expect(svc).toContain("resolveLedgerDocNos");
    expect(svc).toContain("href:");
    // 上海业务日只能走唯一权威模块（CLAUDE.md 共享层）
    expect(svc).toContain('from "@/server/core/business-day"');
    expect(svc).not.toContain('new Intl.DateTimeFormat("en-CA"');
  });

  it("需求达成：渠道下拉来自主数据接口，不再硬编码渠道名", () => {
    const src = read("src/app/(app)/report/demand/demand-client.tsx");
    expect(src).toContain('api="/api/master/channel"');
    expect(src).not.toContain('"天猫", "拼多多"');
    // 与经营分析总览同源
    expect(read("src/app/(app)/report/dashboard/dashboard-client.tsx")).toContain("/api/master/channel");
  });

  it("经营分析总览：页面标题、H1、导出文件名与菜单标签一致", () => {
    const label = ROUTE_REGISTRY.report_dashboard.label;
    expect(label).toBe("经营分析总览");
    expect(read("src/app/(app)/report/dashboard/page.tsx")).toContain(`metadata = { title: "${label}" }`);
    const client = read("src/app/(app)/report/dashboard/dashboard-client.tsx");
    expect(client).toContain(label);
    // 注释里保留事故记载，可渲染文本与导出文件名不得再自称「经营驾驶舱」
    const code = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("经营驾驶舱");
    expect(code).toContain(`<Typography.Title level={4} className="dashboard-header__title">`);
  });
});
