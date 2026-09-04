/**
 * 契约 → 下游读模型 的登记表必须与代码真实引用一致（2026-09-04 审计 #13）。
 *
 * 事故形态：运维面板的连接器卡只说「已选 N 条契约」，不说这些数据**有没有人读**。
 * 实测 8 条用友契约、2 条聚水潭观察流、4 份简道云表单同步得好好的，
 * 下游没有任何读模型消费——占三方配额、占 staging 体积，还在「已选 N 条」里被当成能力展示。
 *
 * 静态映射最怕悄悄过期。本门禁用 grep 逐条比对 `src/server/modules/**` 的真实引用：
 * 接上消费者不登记、删掉消费者不摘登记，都会红。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_CONSUMERS,
  READ_MODEL_LABELS,
  contractsWithoutConsumer,
} from "@/server/integrations/contract-consumers";
import { JIANDAOYUN_FORM_CONTRACTS } from "@/server/integrations/jiandaoyun-contracts";
import { YONYOU_READ_CONTRACTS } from "@/server/integrations/yonyou-contracts";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function walk(rel: string): string[] {
  return readdirSync(path.join(root, rel)).flatMap((entry) => {
    const child = path.posix.join(rel, entry);
    return statSync(path.join(root, child)).isDirectory()
      ? walk(child)
      : /\.tsx?$/.test(entry)
        ? [child]
        : [];
  });
}

const MODULE_ROOT = "src/server/modules";
const moduleFiles = walk(MODULE_ROOT).sort();
const moduleSource = new Map(moduleFiles.map((f) => [f, read(f)]));

/** 真实消费者 = `src/server/modules/**` 里出现该 key 字面量的文件 */
function actualConsumers(key: string): string[] {
  return moduleFiles
    .filter((f) => moduleSource.get(f)!.includes(`"${key}"`))
    .map((f) => f.slice(`${MODULE_ROOT}/`.length))
    .sort();
}

describe("契约 → 下游读模型登记表", () => {
  it("扫描到的模块文件非空（正则/路径写错会让整个门禁静默通过）", () => {
    expect(moduleFiles.length).toBeGreaterThan(100);
  });

  it("每条契约的 consumers 与代码真实引用完全一致", () => {
    const drift: string[] = [];
    for (const entry of CONTRACT_CONSUMERS) {
      const actual = actualConsumers(entry.key);
      const registered = [...entry.consumers].sort();
      if (JSON.stringify(actual) !== JSON.stringify(registered)) {
        drift.push(`${entry.connector}:${entry.key}\n  登记=${registered.join(",") || "（无）"}\n  实际=${actual.join(",") || "（无）"}`);
      }
    }
    expect(drift, "登记表与代码不一致：接上消费者要登记，删掉消费者要摘登记").toEqual([]);
  });

  it("覆盖全部已登记的简道云契约、用友契约与聚水潭数据流（新增契约不能漏登记）", () => {
    const registered = new Set(CONTRACT_CONSUMERS.map((c) => c.key));
    for (const c of JIANDAOYUN_FORM_CONTRACTS) {
      expect(registered.has(c.key), `简道云契约 ${c.key} 未登记下游读模型`).toBe(true);
    }
    for (const c of YONYOU_READ_CONTRACTS) {
      expect(registered.has(c.path), `用友契约 ${c.path} 未登记下游读模型`).toBe(true);
    }
    // 聚水潭四条流的 stream 常量分散在三个同步模块里
    const jstStreams = ["outbound-sales-daily", "inventory-total-delta", "item-master", "inbound-receipts-daily"];
    for (const s of jstStreams) expect(registered.has(s), `聚水潭数据流 ${s} 未登记`).toBe(true);
    expect(read("src/server/integrations/jst-sync.ts")).toContain('const STREAM = "outbound-sales-daily"');
    expect(read("src/server/integrations/jst-inventory-sync.ts")).toContain('const STREAM = "inventory-total-delta"');
    expect(read("src/server/integrations/jst-observation-sync.ts")).toContain('stream: "item-master"');
    expect(read("src/server/integrations/jst-observation-sync.ts")).toContain('stream: "inbound-receipts-daily"');
  });

  it("key 唯一；每个消费者模块都有中文名且文件真实存在", () => {
    const keys = CONTRACT_CONSUMERS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of CONTRACT_CONSUMERS) {
      expect(entry.label.length, `${entry.key} 缺中文名`).toBeGreaterThan(1);
      for (const m of entry.consumers) {
        expect(READ_MODEL_LABELS[m], `${m} 缺中文名`).toBeDefined();
        expect(moduleSource.has(`${MODULE_ROOT}/${m}`), `${m} 不存在`).toBe(true);
      }
    }
    // 标签表不得留下已不再被引用的条目
    const used = new Set(CONTRACT_CONSUMERS.flatMap((c) => c.consumers));
    for (const m of Object.keys(READ_MODEL_LABELS)) {
      expect(used.has(m), `${m} 已无契约引用，请从 READ_MODEL_LABELS 摘除`).toBe(true);
    }
  });

  it("「无消费者」的契约被显式点名（这正是这一列存在的理由）", () => {
    const orphans = contractsWithoutConsumer();
    // 数字会随接线变化；断言的是「这件事被算出来了、并且当前确实存在」
    expect(orphans.length).toBeGreaterThan(0);
    expect(orphans.filter((c) => c.connector === "yy"), "用友八条契约当前全部无下游读模型").toHaveLength(
      YONYOU_READ_CONTRACTS.length,
    );
    expect(orphans.map((c) => c.key)).toContain("item-master");
    expect(orphans.map((c) => c.key)).toContain("inbound-receipts-daily");
  });

  it("运维面板确实展示这一列（登记了却不给人看等于没做）", () => {
    const health = read("src/server/modules/admin/health.ts");
    const client = read("src/app/(app)/admin/health/health-client.tsx");
    expect(health).toContain("contractConsumers");
    expect(health).toContain("CONTRACT_CONSUMERS");
    expect(client).toContain("下游读模型");
    expect(client).toContain("无消费者");
  });
});
