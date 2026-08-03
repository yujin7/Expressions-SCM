/** 一次性：普查 9 个应用下所有表单的最新数据时间，定位 2026 年业务到底记在哪里。只读。用后即删。 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

import { JiandaoyunClient, jiandaoyunConfigFromEnv } from "../src/server/integrations/jiandaoyun";

/** 从一条记录里找出最像"更新时间"的值 */
function newestStamp(rec: Record<string, unknown>): string | null {
  let best: string | null = null;
  for (const key of ["updateTime", "createTime", "_widget_1432193884843"]) {
    const v = rec[key];
    if (typeof v === "string" && /^\d{4}-\d{2}/.test(v)) {
      if (!best || v > best) best = v;
    }
  }
  // 兜底：扫所有字符串字段找 ISO 日期
  if (!best) {
    for (const v of Object.values(rec)) {
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        if (!best || v > best) best = v;
      }
    }
  }
  return best;
}

async function main() {
  const config = jiandaoyunConfigFromEnv();
  if (!config) { console.error("配置不完整"); process.exit(1); return; }
  const client = new JiandaoyunClient(config, { retries: 0 });

  const apps = await client.listApps();
  const hits: { app: string; form: string; entryId: string; newest: string; rows: number }[] = [];

  for (const app of apps) {
    let forms;
    try { forms = await client.listForms(app.appId); } catch { continue; }
    console.log(`\n■ ${app.name}（${forms.length} 张表单）`);
    for (const form of forms) {
      try {
        const rows = await client.listRecords(app.appId, form.entryId);
        if (rows.length === 0) continue;
        let newest: string | null = null;
        for (const r of rows) {
          const s = newestStamp(r as unknown as Record<string, unknown>);
          if (s && (!newest || s > newest)) newest = s;
        }
        if (!newest) continue;
        const year = newest.slice(0, 4);
        if (year >= "2025") {
          console.log(`   ★ ${form.name.padEnd(24)} 最新 ${newest.slice(0,10)}  ${rows.length} 行`);
          hits.push({ app: app.name, form: form.name, entryId: form.entryId, newest, rows: rows.length });
        }
      } catch { /* 无权限/超限的表单跳过 */ }
    }
  }

  console.log(`\n═══ 含 2025 年及以后数据的表单：${hits.length} 张 ═══`);
  hits.sort((a, b) => b.newest.localeCompare(a.newest));
  for (const h of hits.slice(0, 30)) {
    console.log(`  ${h.newest.slice(0,10)}  ${h.app} / ${h.form}  (${h.rows} 行)  ${h.entryId}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => {
  console.error("普查失败：", (e as Error).message.slice(0, 300));
  process.exit(1);
});
