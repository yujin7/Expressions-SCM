/**
 * W2 通知中心平台化 + 通知→告警反查。
 *
 * 两个此前的缺口：
 *  1. `/notifications` 是一条平铺流水——没有筛选、没有分页（服务端恒取最近 100 条）、
 *     没有未读开关。通知一多，昨天那条断货预警就再也翻不到；
 *  2. 系统告警通知的 href 指向的是**处置页**，站内没有任何一条路回到那条告警本身
 *     （看不到规则来源/参数快照，也看不出它是不是已经被关掉了）。
 *
 * dedupeKey 的**构造**在 `jobs/system-alert-notify`，**解析**只有 `lib/notify-links` 一处；
 * 本文件钉住两边同源，以及页面确实用了列表状态平台。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { alertDeepLink, alertIdOfNotification, SYSTEM_ALERT_DEDUPE_PREFIX } from "@/lib/notify-links";

const root = process.cwd();
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

describe("通知 → 告警反查（lib/notify-links）", () => {
  it("解析 system_alert:<id>[:<role>]，其它通知返回 null", () => {
    expect(alertIdOfNotification("system_alert:42")).toBe(42);
    // 数据产品门禁按责任角色拆分 dedupeKey，仍指向同一条告警
    expect(alertIdOfNotification("system_alert:42:pmc")).toBe(42);
    expect(alertIdOfNotification("task:7:assigned")).toBeNull();
    expect(alertIdOfNotification("dq-pack:weekly:2026-W36")).toBeNull();
    expect(alertIdOfNotification(null)).toBeNull();
    expect(alertIdOfNotification("system_alert:abc")).toBeNull();
  });

  it("与 jobs/system-alert-notify 的 dedupeKey 构造同源（前缀写死在一处）", () => {
    const job = read("src/jobs/system-alert-notify.ts");
    expect(job).toContain(`${SYSTEM_ALERT_DEDUPE_PREFIX}\${alert.id}`);
    expect(job).toContain(`${SYSTEM_ALERT_DEDUPE_PREFIX}\${alert.id}:\${targetRole}`);
  });

  it("深链按 id 精确定位，不带状态——通知常常是在告警被关闭之后才被点开", () => {
    expect(alertDeepLink(42)).toBe("/alerts?id=42");
    const api = read("src/app/api/alerts/route.ts");
    expect(api, "命中 id 时必须忽略 status，否则点进来是空列表").toMatch(
      /focusId \? \[eq\(systemAlerts\.id, focusId\)\] : \[eq\(systemAlerts\.status, status\)\]/,
    );
    // 已关闭的单条深链也要带上"为什么关的"
    expect(api).toMatch(/focusId != null \|\| status !== "open"/);
  });
});

describe("通知中心：列表状态平台", () => {
  const client = read("src/app/(app)/notifications/notifications-client.tsx");
  const page = read("src/app/(app)/notifications/page.tsx");
  const api = read("src/app/api/notifications/route.ts");

  it("筛选与分页走 useListState + ListToolbar，并有 Suspense 边界", () => {
    expect(client).toContain('import { useListState } from "@/components/useListState"');
    expect(client).toContain('import ListToolbar from "@/components/ListToolbar"');
    expect(client).toContain("<ListToolbar");
    expect(client).toContain("state={listState}");
    expect(client).toContain("paginationProps");
    expect(page).toContain("<Suspense>");
  });

  it("严重度与已读状态都是筛选项（未读开关不再只是一个数字）", () => {
    expect(client).toMatch(/defaults: \{ severity: "", read: "" \}/);
    expect(api).toContain('searchParams.get("severity")');
    expect(api).toContain('read === "unread"');
    expect(api).toContain('read === "read"');
  });

  it("服务端分页并返回总数（此前恒取 100 条、无 total）", () => {
    expect(api).toContain("count(*)::int");
    expect(api).toContain(".offset((page - 1) * pageSize)");
    expect(api).not.toContain(".limit(100)");
  });

  it("系统告警通知每条给出回到告警的链接", () => {
    expect(api).toContain("alertIdOfNotification");
    expect(client).toContain("alertDeepLink");
    expect(client).toContain("查看告警");
  });

  it("未读数与工作台徽标同源（isNull(readAt) + notifyVisibleWhere），不再各数各的", () => {
    expect(api).toMatch(/and\(isNull\(notifications\.readAt\), notifyVisibleWhere\(user\)\)/);
  });
});
