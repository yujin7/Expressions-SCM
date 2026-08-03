/** 一次性：对销量类表单做全量分页，求真正的最大统计日期（不是首页抽样）。只读。用后即删。 */
import { appendFileSync, readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
import { jiandaoyunConfigFromEnv } from "../src/server/integrations/jiandaoyun";

const OUT = "/tmp/jdy-recency.txt";
const say = (l: string): void => { appendFileSync(OUT, l + "\n"); };
const cfg = jiandaoyunConfigFromEnv();
if (!cfg) { console.error("配置不完整"); process.exit(1); }

async function post(body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${cfg!.baseUrl}/app/entry/data/list`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg!.apiKey}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  return (await r.json()) as Record<string, unknown>;
}

const APP = "699ebeac318154b4f6d3dda6";
const TARGETS: [string, string][] = [
  ["Tmall_C.01_SKU整体", "69a79b2c29154c9870ddaf00"],
  ["Tmall_C.02_退款分布", "69a79cf5180dcc9f36294d4a"],
  ["Pdd_C.01_订单查询列表", "69b2195752dfffff3fcd5da1"],
  ["Vip_A.01_店铺交易", "69d5be62308e25ac8ec1d754"],
];

const MAX_PAGES = 120;
const PAGE = 100;

async function main() {
  for (const [name, entryId] of TARGETS) {
    let cursor: string | null = null;
    let rows = 0, pages = 0;
    let maxStat = "", maxUpd = "";
    try {
      for (; pages < MAX_PAGES; pages++) {
        const body: Record<string, unknown> = { app_id: APP, entry_id: entryId, limit: PAGE };
        if (cursor) body.data_id = cursor;
        const res = await post(body);
        const data = (res.data ?? []) as Record<string, unknown>[];
        if (!Array.isArray(data) || data.length === 0) break;
        for (const r of data) {
          rows++;
          const sd = String(r.statistical_date ?? "");
          if (/^\d{4}-/.test(sd) && sd > maxStat) maxStat = sd;
          const ut = String(r.updateTime ?? "");
          if (/^\d{4}-/.test(ut) && ut > maxUpd) maxUpd = ut;
        }
        if (data.length < PAGE) break;
        cursor = String(data[data.length - 1]._id ?? "");
        if (!cursor) break;
      }
      const capped = pages >= MAX_PAGES ? "（达页上限，仍可能有更多）" : "";
      say(`${name.padEnd(24)} 行=${String(rows).padStart(6)} 页=${String(pages+1).padStart(3)} 最大统计日=${maxStat.slice(0,10) || "—"} 最大更新=${maxUpd.slice(0,10) || "—"} ${capped}`);
    } catch (e) {
      say(`${name.padEnd(24)} 失败：${(e as Error).message.slice(0,80)}（已读 ${rows} 行）`);
    }
  }
  say("DONE");
}
void main().then(() => process.exit(0)).catch((e) => { say("失败:"+(e as Error).message); process.exit(1); });
