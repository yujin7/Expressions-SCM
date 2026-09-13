/**
 * 采购侧界面契约：能力已经存在，但没有入口 = 等于不存在。
 *
 * 事故背景（2026-09-04 审计）：
 * 1) `transitionPO` / `transitionWO`（完成 / 短关）有服务、有路由、有测试
 *    （tests/outsource/short-close-supply.test.ts），**唯独没有按钮**。
 *    结果：供应商少送尾数的 PO 永久停在「执行中」，把 OTIF 的 pending 桶越撑越大。
 * 2) PO 详情不显示行级承诺交期，也不显示 `po_promise_revisions`——供应商在门户改了三次交期，
 *    内部看不到任何痕迹；列表更是把接口已返回的 expectedDate/confirmedAt 整列丢掉。
 * 3) `/master/supplier` 是纯 CRUD：采购在这里维护档案，却看不到 OTIF / 交期 / 质检 / 账期任何一项。
 * 4) 三套交期口径（记分卡 OTIF、系统学习、简道云观察）此前分散在两个菜单分组。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("采购侧界面契约", () => {
  it("完成 / 短关按钮存在，角色门与路由服务层一致，短关强制填原因", () => {
    const comp = read("src/components/DocTransitionActions.tsx");
    // 与 transitionPO / transitionWO 的 requireAnyRole(user, "pmc", "ops") 同口径
    expect(comp).toContain('hasAnyRole(me, "pmc", "ops")');
    const recovery = read("src/components/doc-transition-recovery.ts");
    expect(recovery).toContain("/transition");
    expect(comp).toContain('postClosingAction(base, action, doc.version, reason)');
    // 短关必须填原因：按钮在原因为空时禁用（服务端 schema 也强制，这里只是别让人白跑一趟）
    expect(comp).toContain('action === "short_close" && reason.trim().length === 0');
    // 状态机边（docflow/state.ts）：complete 只从 in_progress，short_close 从 approved / in_progress
    expect(comp).toContain('return status === "in_progress";');
    expect(comp).toContain('return status === "approved" || status === "in_progress";');

    for (const [file, docType] of [
      ["src/app/(app)/outsource/po/po-client.tsx", "po"],
      ["src/app/(app)/outsource/wo/wo-client.tsx", "wo"],
    ] as const) {
      const src = read(file);
      expect(src, file).toContain("DocTransitionActions");
      expect(src, file).toContain(`docType="${docType}"`);
      // 收口后单据落到 closed，列表要有对应页签，否则短关完就再也找不到
      expect(src, file).toContain('{ key: "closed", label: "已短关" }');
    }

    // 路由确实存在（按钮不能指向不存在的接口）
    for (const rel of ["src/app/api/outsource/po/[id]/transition/route.ts", "src/app/api/outsource/wo/[id]/transition/route.ts"]) {
      expect(read(rel), rel).toContain("guardFreshWrite");
    }
  });

  it("PO 详情显示行级承诺交期与承诺变更时间线；列表补齐预计到货/已确认/已收%/逾期", () => {
    const src = read("src/app/(app)/outsource/po/po-client.tsx");
    // 行级交期
    expect(src).toContain('title: "行承诺交期"');
    expect(src).toContain('dataIndex: "expectedDate"');
    // 承诺时间线
    expect(src).toContain("promiseRevisions");
    expect(src).toContain("交期承诺变更");
    expect(src).toContain("PROMISE_SOURCE_LABELS");
    expect(src).toContain("PROMISE_ACTOR_LABELS");
    // 列表四列
    for (const title of ["预计到货", "已确认", "已收%", "逾期"]) {
      expect(src, title).toContain(`title: "${title}"`);
    }
    expect(src).toContain("receivedPct");
    expect(src).toContain("overdueDays");

    // 服务端确实 select 了行级交期并读了承诺表（前端有列但后端没数据等于没做）
    const svc = read("src/server/modules/outsource/po.ts");
    expect(svc).toContain("expectedDate: poLines.expectedDate");
    expect(svc).toContain("listPoPromiseRevisions");
    expect(svc).toContain("poListProgress");
  });

  it("供应商 360 抽屉：四个既有读模型并排，金额按角色、观察值标 observation_only", () => {
    const client = read("src/app/(app)/master/supplier/supplier-client.tsx");
    expect(client).toContain("Supplier360Drawer");
    expect(client).toContain("供应商 360");
    expect(client).toContain('aria-label="申报月产能" stringMode min="0" max="9999999999.9999"');

    const drawer = read("src/app/(app)/master/supplier/supplier-360-drawer.tsx");
    expect(drawer).toContain("/360`");
    // 四块内容
    for (const section of ["记分卡", "采购订单指标", "账期", "历史交期观察"]) {
      expect(drawer, section).toContain(section);
    }
    // 金额只在服务端说可见时才显示，不可见显式说明「无权限」而不是渲染成 0 或空
    expect(drawer).toContain("moneyVisible");
    expect(drawer).toContain('"无权限"');
    // 观察线只观察不改
    expect(drawer).toContain("observation_only");
    // 客户端只能类型导入服务端模块（client-server-boundary 护栏）
    expect(drawer).toContain('import type { Supplier360 } from "@/server/modules/master/supplier-360"');
    // 静态回归防止回退固定三列；实际单元格几何与长依据仍须浏览器验证。
    expect(drawer).toContain('column={{ xs: 1, sm: 2, lg: 3 }}');
    expect(drawer).not.toContain('column={3}');
    expect(drawer).toContain('span: "filled"');
    expect(drawer).toContain('<summary>查看完整申报依据</summary>');

    const svc = read("src/server/modules/master/supplier-360.ts");
    for (const model of [
      "supplier-scorecard", "purchase-order-metrics", "supplier-payment-term", "supplier-lead-history",
    ]) {
      expect(svc, model).toContain(model);
    }
    // 装配层不得自己再算一套：只挑该供应商那一行
    expect(svc).toContain("stripPurchaseOrderMoney");
    expect(svc).toContain("stripSupplierPaymentTermMoney");

    const route = read("src/app/api/master/supplier/[id]/360/route.ts");
    expect(route).toContain("guardFreshWrite");
    expect(route).toContain("maskSensitive");
  });

  it("交期学习并入记分卡第六页签，旧路径保留跳转，三套交期口径各自带表头", () => {
    const shell = read("src/app/(app)/report/supplier-scorecard/supplier-scorecard-client.tsx");
    expect(shell).toContain('{ key: "leadtime", label: "交期学习", children: <LeadTimeLearningTab /> }');
    expect(shell).toContain('requestedTab === "leadtime"');
    // 与「历史交期观察」并排
    expect(shell).toContain('{ key: "lead-history", label: "历史交期观察"');

    const tab = read("src/app/(app)/report/supplier-scorecard/leadtime-learning-tab.tsx");
    // 每套口径自己的表头 + 独立 URL 命名空间（不得与 sc_/qc_/pv_/pt_/lh_ 撞）
    expect(tab).toContain("采购首批交期学习（系统记录）");
    expect(tab).toContain("首批到货不等于全部收齐");
    expect(tab).toContain("不改加工周期");
    expect(tab).toContain('paramPrefix: "lt"');

    // 旧路径 → 跳转，而不是 404
    const legacy = read("src/app/(app)/report/leadtime-learning/page.tsx");
    expect(legacy).toContain('redirect("/report/supplier-scorecard?tab=leadtime")');
  });
});
