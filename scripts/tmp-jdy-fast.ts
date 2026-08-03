/** 一次性：轻量普查——每张表单只取 1 页 5 条，找出哪些表单还有 2025/2026 年数据。只读。用后即删。 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

import { jiandaoyunConfigFromEnv } from "../src/server/integrations/jiandaoyun";

const cfg = jiandaoyunConfigFromEnv();
if (!cfg) { console.error("配置不完整"); process.exit(1); }

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${cfg!.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg!.apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return (await r.json()) as Record<string, unknown>;
}

/** 扫记录里所有形如日期的字符串，取最大值 */
function newest(rec: Record<string, unknown>): string | null {
  let best: string | null = null;
  const walk = (v: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof v === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(v) && (!best || v > best)) best = v;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(rec, 0);
  return best;
}

async function main() {
  const appsRes = await post("/app/list", { limit: 100 });
  const apps = (appsRes.apps ?? []) as { app_id: string; name: string }[];
  console.log(`应用 ${apps.length} 个\n`);

  const hits: { app: string; form: string; entryId: string; newest: string }[] = [];
  let scanned = 0;

  for (const app of apps) {
    const formsRes = await post("/app/entry/list", { app_id: app.app_id, limit: 100 });
    const forms = (formsRes.forms ?? []) as { entry_id: string; name: string }[];
    for (const form of forms) {
      scanned++;
      try {
        const dataRes = await post("/app/entry/data/list", {
          app_id: app.app_id, entry_id: form.entry_id, limit: 5,
        });
        const rows = (dataRes.data ?? []) as Record<string, unknown>[];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        let top: string | null = null;
        for (const r of rows) {
          const s = newest(r);
          if (s && (!top || s > top)) top = s;
        }
        if (top && top.slice(0, 4) >= "2025") {
          hits.push({ app: app.name, form: form.name, entryId: form.entry_id, newest: top });
          console.log(`★ ${top.slice(0, 10)}  ${app.name} / ${form.name}`);
        }
      } catch { /* 跳过 */ }
    }
  }

  console.log(`\n═══ 扫描 ${scanned} 张表单，含 2025+ 数据的 ${hits.length} 张 ═══`);
  hits.sort((a, b) => b.newest.localeCompare(a.newest));
  for (const h of hits.slice(0, 40)) {
    console.log(`  ${h.newest.slice(0, 10)}  ${h.app} / ${h.form}   ${h.entryId}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => {
  console.error("失败：", (e as Error).message.slice(0, 300));
  process.exit(1);
});
