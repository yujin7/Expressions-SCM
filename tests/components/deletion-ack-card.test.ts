/**
 * 删除墓碑卡片：**签字前的形状指引必须在界面上**，不能只留在同步的报错文本里。
 *
 * 事故背景（2026-09-04 → 09-05）：同步因「6447 < 6448」停摆两天，拒绝是对的，
 * 但当时没有任何让人确认的路径。补了路径之后，最容易做坏的一步是
 * **让人把一次分页/权限截断当成删除逐条签掉**——签完基线就被悄悄削掉一截。
 * 服务端已经拒绝这种情况（截断即使签满墓碑也不放行），界面必须**事先**说清楚，
 * 而不是让人签了一堆字再被拒。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/app/(app)/admin/health/health-client.tsx", "utf8");
const card = src.slice(src.indexOf("function DeletionAckCard"));

describe("删除墓碑卡片", () => {
  it("界面上写明「尾部整段消失不要签」——这是最容易被做坏的一步", () => {
    expect(card).toContain("尾部整段消失");
    expect(card).toContain("不要签");
    expect(card, "也要说清楚什么情况才值得签").toContain("零散缺失");
  });

  it("说明「一次只放行这一条」，不给人「以后丢的都算数」的错觉", () => {
    expect(card).toMatch(/一次确认只放行这一条/);
  });

  it("依据不足 4 字时提交按钮禁用（DB 也有 check 约束，两层都要有）", () => {
    expect(card).toMatch(/reason\.trim\(\)\.length < 4/);
  });

  it("撤销要二次确认，并说明撤销后同步会重新拒绝", () => {
    expect(card).toContain("Popconfirm");
    expect(card).toMatch(/撤销后同步会重新拒绝/);
  });

  it("卡片挂在运维页上（同步报错的人就在这一页看连接器运行史）", () => {
    expect(src).toContain("<DeletionAckCard />");
    expect(src.indexOf("连接器最近运行与检查点")).toBeLessThan(src.indexOf("<DeletionAckCard />"));
  });
});
