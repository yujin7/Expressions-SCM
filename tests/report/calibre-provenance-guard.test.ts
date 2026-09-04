/**
 * 出处文案守卫（审计 C6）——**本文件的存在意义就是让下一次改名不能静默上线**。
 *
 * 事故形态：驾驶舱与趋势页每个块都在 `Block.source.source` 里写着自己的来源口径，
 * 例如「inventory-alerts/v1 × jiandaoyun-external-velocity/v3（观察只预警不定量）」。
 * 这串字是**手抄的字面量**，读模型升版时没人记得同步：审计当天实测
 * `cockpit.ts` 挂着 `purchase-order-metrics/v1`（常量早已是 /v2）、
 * `cockpit-trends.ts` 挂着 `inventory-alerts/v1` 与 `replenish-pilot/v1`（常量是 /v2）。
 * 总监看到的口径版本号，指向的是代码根本没在跑的那一版。
 *
 * 守卫做法：把两份装配载荷里**每一个** `Block.source.source` 字符串走一遍，
 * 抠出其中所有 `<模型名>/v<N>` 记号，与各读模型**导出的键常量**逐一比对：
 *   - 版本对不上 → 红（就是上面那三处）；
 *   - 名字不在注册表里 → 也红（新读模型必须把键常量导出并登记，否则守卫覆盖不到它）。
 *
 * 因此正确的修法只有一种：文案由键常量派生（模板串），而不是再抄一遍。
 *
 * ── W2 扩面 ──
 * 本守卫此前只走驾驶舱与趋势层这两份装配载荷，于是本波新增的四个口径面
 * （先挪后买装配、流水金额、风险金额、效期金额）**一个版本记号都不发**，守卫看不见它们：
 * 既谈不上"版本漂了"，也谈不上"没登记"——它们根本不在检查范围里。
 * 现在这四个面各自导出一个口径常量并把它下发到载荷里，守卫扫它们的**全部字符串**
 * （不是只扫 `Block.source.source`——这些面不是 Block），逐个记号比对注册表：
 *   - 记号版本 ≠ 当前常量 → 红；
 *   - 记号的模型名没登记 → 红；
 *   - 某个面**一个记号都不发** → 红（这正是它们此前的状态：没有信号 = 守卫失效）。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import type { SessionUser } from "@/server/core/dto";
import { getCockpit, type Block } from "@/server/modules/report/cockpit";
import { getCockpitTrends } from "@/server/modules/report/cockpit-trends";

import { ALERT_OUTCOME_VERSION } from "@/jobs/alert-outcome";
import { CHANNEL_OBSERVATION_CACHE_KEY } from "@/server/modules/report/channel-observation";
import { DATA_QUALITY_CACHE_KEY } from "@/server/modules/report/data-quality";
import { EXTERNAL_DEMAND_SIGNAL_CACHE_KEY } from "@/server/modules/report/external-demand-signal";
import { EXTERNAL_VELOCITY_CACHE_KEY } from "@/server/modules/report/external-velocity";
import { INVENTORY_ALERTS_CACHE_KEY } from "@/server/modules/report/inventory-alerts";
import { INVENTORY_POSITION_CACHE_KEY } from "@/server/modules/report/inventory-position";
import { INVENTORY_SALES_RATIO_CACHE_KEY } from "@/server/modules/report/inventory-sales-ratio";
import { PILOT_CACHE_KEY } from "@/server/modules/report/replenish-pilot";
import { PURCHASE_ORDER_METRICS_KEY } from "@/server/modules/report/purchase-order-metrics";
import { RISK_EXPIRY_BUCKETS_KEY } from "@/server/modules/report/risk-expiry-buckets";
import { SALES_SPIKE_CACHE_KEY } from "@/server/modules/report/sales-spike";
import { SUPPLIER_PAYMENT_TERM_KEY } from "@/server/modules/report/supplier-payment-term";
import { TRANSFER_ROUTES_CACHE_KEY } from "@/server/modules/report/transfer-routes";
import { WAREHOUSE_INVENTORY_CACHE_KEY } from "@/server/modules/report/warehouse-inventory";
/* W2 新增的四个口径面（不是 Block，各自把口径记号下发在载荷里） */
import { MOVE_OR_BUY_CALIBRE_KEY, getMoveOrBuyDecisions } from "@/server/modules/report/move-or-buy";
import { RISK_MONEY_CALIBRE_KEY, getRiskWorklist } from "@/server/modules/report/risk";
import { EXPIRY_MONEY_CALIBRE_KEY, listExpiryBatches } from "@/server/modules/inventory/expiry-list";
import { LEDGER_MONEY_CALIBRE_KEY, listLedger } from "@/server/modules/inventory/queries";

/**
 * 出处文案里**允许出现**的所有 `<名>/v<N>` 记号，全部取自各模块导出的键常量。
 * 新增读模型上驾驶舱时：把它的键常量 export 出来加到这里；不加就红。
 */
const CALIBRE_KEYS: readonly string[] = [
  ALERT_OUTCOME_VERSION,
  CHANNEL_OBSERVATION_CACHE_KEY,
  DATA_QUALITY_CACHE_KEY,
  EXTERNAL_DEMAND_SIGNAL_CACHE_KEY,
  EXTERNAL_VELOCITY_CACHE_KEY,
  INVENTORY_ALERTS_CACHE_KEY,
  INVENTORY_POSITION_CACHE_KEY,
  INVENTORY_SALES_RATIO_CACHE_KEY,
  PILOT_CACHE_KEY,
  PURCHASE_ORDER_METRICS_KEY,
  RISK_EXPIRY_BUCKETS_KEY,
  SALES_SPIKE_CACHE_KEY,
  SUPPLIER_PAYMENT_TERM_KEY,
  TRANSFER_ROUTES_CACHE_KEY,
  WAREHOUSE_INVENTORY_CACHE_KEY,
  MOVE_OR_BUY_CALIBRE_KEY,
  RISK_MONEY_CALIBRE_KEY,
  EXPIRY_MONEY_CALIBRE_KEY,
  LEDGER_MONEY_CALIBRE_KEY,
];

/** 模型名 → 当前版本键（"inventory-alerts" → "inventory-alerts/v4"） */
const CURRENT_BY_NAME = new Map(CALIBRE_KEYS.map((k) => [k.slice(0, k.lastIndexOf("/")), k]));

/** 形如 `foo-bar/v2` 的记号；只认小写字母、数字与连字符构成的模型名 */
const CALIBRE_TOKEN = /[a-z][a-z0-9-]*\/v\d+/g;

function isBlock(v: unknown): v is Block<unknown> {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const src = o.source as Record<string, unknown> | undefined;
  return typeof o.state === "string" && typeof o.note === "string"
    && src != null && typeof src === "object" && typeof src.source === "string";
}

/** 递归收集载荷里每一个 Block 的出处文案（附路径，红的时候能一眼定位） */
function collectSourceStrings(node: unknown, path: string, out: { path: string; text: string }[]): void {
  if (node == null || typeof node !== "object") return;
  if (isBlock(node)) {
    out.push({ path, text: (node.source as { source: string }).source });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectSourceStrings(v, `${path}[${i}]`, out));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    collectSourceStrings(v, path ? `${path}.${k}` : k, out);
  }
}

/** 递归收集载荷里**每一个**字符串（新口径面不是 Block，没有统一的 source 字段） */
function collectAllStrings(node: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof node === "string") {
    out.push({ path, text: node });
    return;
  }
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectAllStrings(v, `${path}[${i}]`, out));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    collectAllStrings(v, path ? `${path}.${k}` : k, out);
  }
}

/** 逐记号比对注册表；返回漂移与未登记两张清单 */
function checkTokens(found: { path: string; text: string }[]): {
  checked: number; drifted: string[]; unregistered: string[];
} {
  const drifted: string[] = [];
  const unregistered: string[] = [];
  let checked = 0;
  for (const { path, text } of found) {
    for (const token of text.match(CALIBRE_TOKEN) ?? []) {
      checked += 1;
      const name = token.slice(0, token.lastIndexOf("/"));
      const current = CURRENT_BY_NAME.get(name);
      if (current == null) unregistered.push(`${path}: ${token}`);
      else if (current !== token) drifted.push(`${path}: 文案写 ${token}，当前常量是 ${current}`);
    }
  }
  return { checked, drifted, unregistered };
}

describe("驾驶舱出处文案不得指向已不存在的口径版本（C6 守卫）", () => {
  it("cockpit 与 cockpit-trends 的每个 Block.source.source 里的 /vN 都必须等于当前导出的键常量", async () => {
    const { db, client } = await createTestDb();
    try {
      const [u] = await db.insert(schema.users).values({ name: "管理员", roles: ["admin"] }).returning();
      const admin: SessionUser = { id: u.id, name: u.name, roles: ["admin"], isApprover: false, channelScope: null };

      const found: { path: string; text: string }[] = [];
      collectSourceStrings((await getCockpit(admin, db)).screens, "cockpit", found);
      collectSourceStrings((await getCockpitTrends(admin, db)).screens, "trends", found);

      // 装配确实产出了一批块（守卫不能因为什么都没收集到而"通过"）
      expect(found.length).toBeGreaterThan(20);

      const { checked, drifted, unregistered } = checkTokens(found);

      // 出处文案里必须真的出现过版本号——否则本守卫形同虚设
      expect(checked).toBeGreaterThan(10);
      expect(drifted, "出处文案指向了已不存在的口径版本（应由键常量派生，不要手抄字面量）").toEqual([]);
      expect(unregistered, "出处文案里的读模型没有登记键常量：把它的键 export 出来加进 CALIBRE_KEYS").toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("注册表本身是自洽的：每个键都形如 <名>/v<N> 且模型名不重复", () => {
    for (const key of CALIBRE_KEYS) expect(key).toMatch(/^[a-z][a-z0-9-]*\/v\d+$/);
    expect(CURRENT_BY_NAME.size).toBe(CALIBRE_KEYS.length);
  });

  /* ── W2：本波新增的四个口径面也必须在守卫视野内 ──
     此前它们一个版本记号都不发，守卫扫不到 = 守卫对它们完全失效。 */
  it("先挪后买 / 流水金额 / 风险金额 / 效期金额：各自发出口径记号，且记号已登记、版本不漂", async () => {
    const { db, client } = await createTestDb();
    try {
      const surfaces: { name: string; expectKey: string; payload: unknown }[] = [
        {
          name: "move-or-buy",
          expectKey: MOVE_OR_BUY_CALIBRE_KEY,
          payload: await getMoveOrBuyDecisions({ roles: ["pmc"] }, db),
        },
        {
          name: "risk-money",
          expectKey: RISK_MONEY_CALIBRE_KEY,
          payload: await getRiskWorklist({ withValue: true }, db),
        },
        {
          name: "expiry-money",
          expectKey: EXPIRY_MONEY_CALIBRE_KEY,
          payload: await listExpiryBatches({ withValue: true }, db),
        },
        {
          name: "ledger-money",
          expectKey: LEDGER_MONEY_CALIBRE_KEY,
          payload: await listLedger({ page: 1, pageSize: 20, withValue: true }, db),
        },
      ];

      for (const s of surfaces) {
        const found: { path: string; text: string }[] = [];
        collectAllStrings(s.payload, s.name, found);
        const tokens = found.flatMap((f) => f.text.match(CALIBRE_TOKEN) ?? []);
        expect(
          tokens,
          `${s.name} 的载荷里必须带口径记号——一个不发版本号的面，本守卫对它等于不存在`,
        ).toContain(s.expectKey);
        const { drifted, unregistered } = checkTokens(found);
        expect(drifted, `${s.name} 的口径记号指向了已不存在的版本`).toEqual([]);
        expect(unregistered, `${s.name} 的口径记号没有登记进 CALIBRE_KEYS`).toEqual([]);
      }
    } finally {
      await client.close();
    }
  });
});
