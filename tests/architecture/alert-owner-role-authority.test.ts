/**
 * 护栏（红队审计 A4）：看门狗不得把告警的责任角色写死成与权威表冲突的值。
 *
 * 事故形态：`rules/task-triggers.ALERT_OWNER_ROLE` 自称并且确实是责任角色的唯一权威——
 * 待办派单（todo/triggers → projectCandidates）、人工关闭权限（alerts/engine.closeAlert）
 * 与通知受众（jobs/system-alert-notify）三处都读它。而 jobs/alert-watchdogs.ts 把
 * `sales_spike` 写死成 `ops`（表里是 `pmc`）：于是同一条爆单告警的待办派给了 PMC、
 * 通知和关闭权限却在运营手上——两边都以为对方在管。
 *
 * 本护栏对每个写告警的任务文件：
 *  1. 收集它的告警类别（ALERT_CATEGORY = "x" 或 category: "x"）；
 *  2. 收集所有 `ownerRole: "字面量"`；
 *  3. 只要该文件里出现的责任角色字面量与它任一类别在权威表里的值都对不上，就判失败。
 * 唯一豁免：文件里根本没有类别（例如通用工具），这种情况本来就不该写死角色。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ALERT_OWNER_ROLE } from "@/server/rules/task-triggers";

const ROOT = path.resolve(__dirname, "../..");
const JOBS = path.join(ROOT, "src/jobs");

interface WatchdogFile {
  file: string;
  categories: string[];
  hardcodedOwnerRoles: string[];
}

function watchdogFiles(): WatchdogFile[] {
  const out: WatchdogFile[] = [];
  for (const entry of readdirSync(JOBS)) {
    if (!entry.endsWith(".ts")) continue;
    const src = readFileSync(path.join(JOBS, entry), "utf8");
    if (!src.includes("insert(systemAlerts)") && !src.includes("upsertAlerts(")) continue;
    const categories = [...new Set([...src.matchAll(/(?:ALERT_CATEGORY\s*=\s*|category:\s*)"([a-z_]+)"/g)].map((m) => m[1]))];
    const hardcodedOwnerRoles = [...new Set([...src.matchAll(/ownerRole:\s*"([a-z_]+)"/g)].map((m) => m[1]))];
    out.push({ file: entry, categories, hardcodedOwnerRoles });
  }
  return out;
}

describe("护栏：告警责任角色只认 ALERT_OWNER_ROLE", () => {
  const files = watchdogFiles();

  it("扫得到写告警的任务（护栏不能静默扫到 0 个文件）", () => {
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((f) => f.file === "alert-watchdogs.ts")).toBe(true);
  });

  it("没有任何看门狗把 ownerRole 写死成与权威表冲突的值", () => {
    const conflicts: string[] = [];
    for (const f of files) {
      for (const role of f.hardcodedOwnerRoles) {
        const authoritative = f.categories.map((c) => ALERT_OWNER_ROLE[c]).filter(Boolean);
        if (!authoritative.includes(role as (typeof ALERT_OWNER_ROLE)[string])) {
          conflicts.push(
            `${f.file}: ownerRole: "${role}" 与权威表冲突（该文件的类别 ${f.categories.join("/") || "(无)"} 对应 ${authoritative.join("/") || "(无)"}）`,
          );
        }
      }
    }
    expect(conflicts, `请改成读 ALERT_OWNER_ROLE[<category>]：\n${conflicts.join("\n")}`).toEqual([]);
  });

  it("爆单与断货两个类别的权威值本身没有漂移（本波裁定：都归 pmc）", () => {
    expect(ALERT_OWNER_ROLE.sales_spike).toBe("pmc");
    expect(ALERT_OWNER_ROLE.inventory_cover).toBe("pmc");
    const watchdogs = readFileSync(path.join(JOBS, "alert-watchdogs.ts"), "utf8");
    expect(watchdogs).toContain("ALERT_OWNER_ROLE[\"sales_spike\"]");
    expect(watchdogs).toContain("ALERT_OWNER_ROLE[\"inventory_cover\"]");
  });
});
