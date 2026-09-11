import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MigrationHealthCard } from "@/app/(app)/admin/health/health-client";
import type { OpsHealth } from "@/server/modules/admin/health";

type Migrations = OpsHealth["migrations"];
const current: Migrations = { files: 2, applied: 2, drift: false, state: "current", ready: true };
const render = (migrations: Migrations, dbOk = true) => renderToStaticMarkup(createElement(MigrationHealthCard, { dbOk, migrations }));

describe("admin migration readiness card", () => {
  it("仅已确认的一致计数显示就绪，不声称全量 schema 一致", () => {
    const html = render(current);
    expect(html).toContain("迁移计数一致");
    expect(html).toContain("2/2 已应用");
    expect(html).toContain("DB 可连接");
    expect(html).not.toContain("ant-tag-red");
    expect(html).not.toContain("schema 一致");
  });

  it.each([
    { state: "behind" as const, applied: 1, label: "迁移落后" },
    { state: "ahead" as const, applied: 3, label: "迁移超前" },
    { state: "unknown" as const, applied: -1, label: "迁移状态未知" },
  ])("$label 不会因 DB 可连接显示正常", ({ state, applied, label }) => {
    const html = render({ ...current, state, applied, ready: false, drift: state !== "unknown" });
    expect(html).toContain(label);
    expect(html).toContain("ant-tag-red");
    expect(html).toContain("background:#fff2f0");
    expect(html).toContain("DB 可连接");
    expect(html).not.toContain("迁移计数一致");
  });

  it("旧 applied=-2 响应不能当 PG 正常，缺新就绪字段保守显示未知", () => {
    const old = { files: 2, applied: -2, drift: false } as Migrations;
    const html = render(old);
    expect(html).toContain("迁移状态未知");
    expect(html).toContain("迁移计数尚未确认");
    expect(html).toContain("ant-tag-red");
    expect(html).not.toContain("PG 模式");
  });

  it("DB 不可用优先于先前就绪信息", () => {
    const html = render(current, false);
    expect(html).toContain("DB 不可用");
    expect(html).toContain("ant-tag-red");
    expect(html).not.toContain("DB 可连接");
    expect(html).not.toContain("迁移计数一致");
  });

  it("冲突的 ready 标记不能覆盖明确的 unknown", () => {
    expect(render({ ...current, state: "unknown" })).toContain("迁移状态未知");
    expect(render({ ...current, state: "unknown" })).not.toContain("迁移计数一致");
  });
});
