/**
 * 简道云表单时效普查：列出每个应用下各表单的最新数据时间。
 *
 * `npm run jdy:survey`
 *
 * 为什么需要它（2026-08-04 实测教训）：已配置的 9 条观察契约全部指向「采购供应链」，
 * 而那批表全量拉数后的 sourceAsOf 是 2024-12-11。当时的结论一度是"简道云数据太旧、
 * 需要业务授权当前视图"——**其实当前 key 一直读得到活跃得多的数据，契约只是指错了地方**：
 * 抽样 216 张表单，117 张能看到 2025 年及以后的记录。
 *
 * 所以这不是一次性排查，而是**每次要判断"该接哪张表"时都该先跑一遍**的工具。
 *
 * 只读：每张表单只取 1 页 5 条，不写任何数据，不打印字段值（避免业务数据进日志），
 * 只输出应用名/表单名/entry_id/最新时间。
 *
 * ⚠ **口径限制：这是抽样，不是全量最大值。** 简道云 data/list 默认按 _id 顺序返回，
 * 首页 5 条通常是较早的记录，因此本工具给出的"最新时间"是**下界**——
 * 表单实际可能有更新的数据在后续分页里。用途是**快速定位哪些表单明显还在用**，
 * 不能用来断言"某表单已停更"。要证明停更必须走全量分页
 * （契约同步走的就是全量，其 sourceAsOf 才是真最大值）。
 *
 * ⚠ 表单名会骗人：`CW_A.01_聚水潭_销售出库单` 实际只有 5 个字段
 * （统计日期/店铺名称/销售成本/物流成本/扣费类型），是费用汇总而非订单明细。
 * 选表前务必用 `/app/entry/widget/list` 看字段，不要照名字下结论。
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

import { jiandaoyunConfigFromEnv } from "../src/server/integrations/jiandaoyun";

const config = jiandaoyunConfigFromEnv();
if (!config) {
  console.error("简道云配置不完整（缺 JIANDAOYUN_API_KEY / BASE_URL）");
  process.exit(1);
}

/** 只关心这个年份及以后的数据；可用 argv[0] 覆盖 */
const SINCE_YEAR = process.argv[2] ?? "2025";

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${config!.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config!.apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** 扫记录里形如日期的字符串取最大值；只用于判断时效，不输出内容 */
function newestStamp(record: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  let best: string | null = null;
  if (typeof record === "string") {
    return /^\d{4}-\d{2}-\d{2}/.test(record) ? record : null;
  }
  if (Array.isArray(record)) {
    for (const item of record) {
      const s = newestStamp(item, depth + 1);
      if (s && (!best || s > best)) best = s;
    }
    return best;
  }
  if (record && typeof record === "object") {
    for (const value of Object.values(record)) {
      const s = newestStamp(value, depth + 1);
      if (s && (!best || s > best)) best = s;
    }
  }
  return best;
}

async function main(): Promise<void> {
  const appsRes = await post("/app/list", { limit: 100 });
  const apps = (appsRes.apps ?? []) as { app_id: string; name: string }[];
  console.log(`简道云可见应用 ${apps.length} 个；只列出抽样中含 ${SINCE_YEAR} 年及以后数据的表单`);
  console.log("⚠ 抽样口径：每表首页 5 条，时间为下界而非最大值；不能据此断言某表已停更\n");

  const hits: { app: string; form: string; entryId: string; newest: string }[] = [];
  let scanned = 0;

  for (const app of apps) {
    const formsRes = await post("/app/entry/list", { app_id: app.app_id, limit: 100 });
    const forms = (formsRes.forms ?? []) as { entry_id: string; name: string }[];
    let appHits = 0;
    for (const form of forms) {
      scanned++;
      try {
        const dataRes = await post("/app/entry/data/list", {
          app_id: app.app_id,
          entry_id: form.entry_id,
          limit: 5,
        });
        const rows = (dataRes.data ?? []) as unknown[];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const top = newestStamp(rows);
        if (top && top.slice(0, 4) >= SINCE_YEAR) {
          hits.push({ app: app.name, form: form.name, entryId: form.entry_id, newest: top });
          appHits++;
        }
      } catch { /* 无权限/超限的表单跳过，不影响整体普查 */ }
    }
    console.log(`  ${app.name.padEnd(12)} ${String(forms.length).padStart(3)} 张表单，其中 ${appHits} 张有近期数据`);
  }

  hits.sort((a, b) => b.newest.localeCompare(a.newest));
  console.log(`\n═══ 扫描 ${scanned} 张，含 ${SINCE_YEAR}+ 数据 ${hits.length} 张（按最新时间倒序）═══`);
  for (const hit of hits) {
    console.log(`  ${hit.newest.slice(0, 10)}  ${hit.app} / ${hit.form}   ${hit.entryId}`);
  }
  console.log(
    "\n提示：选表前请用 /app/entry/widget/list 核对字段——表单名与实际字段常不一致"
    + "（例：`CW_A.01_聚水潭_销售出库单` 实为按店铺×日期的费用汇总，非订单明细）。\n",
  );
}
void main().catch((error) => {
  console.error("普查失败：", (error as Error).message.slice(0, 300));
  process.exit(1);
});
