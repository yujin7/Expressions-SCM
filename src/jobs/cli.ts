/**
 * 后台任务 CLI（PGlite 开发模式下 pg_boss 不可用——任务须可独立手跑）：
 *   npx tsx src/jobs/cli.ts reconcile-jst [YYYY-MM-DD]   # 缺省=昨日（Asia/Shanghai）
 *   npx tsx src/jobs/cli.ts sync-jst [YYYY-MM-DD]        # API 拉取到受控 staging
 *   npx tsx src/jobs/cli.ts sync-jst-inventory           # 增量库存观察到受控 staging
 *   npx tsx src/jobs/cli.ts license-alert [YYYY-MM-DD]   # 缺省=今日
 *   npx tsx src/jobs/cli.ts stage-jst <file.xlsx|csv> <userId>
 * 输出 JSON summary；失败退出码非 0。
 */
import { getDbAsync } from "@/db";
import { runReconcileJst, shanghaiToday } from "./reconcile-jst";
import { runLicenseAlert } from "./license-alert";
import { runSnapshotAgeAlert } from "./snapshot-age";
import { runExportWorkerOnce } from "./export-worker";
import { runHousekeeping } from "./housekeeping";
import { stageJstDaily } from "@/server/import/adapters/jst-daily";
import { runJstInventorySync, runJstSalesSync } from "./sync-jst";
import {
  runJiandaoyunCatalogSync,
  runJiandaoyunConfiguredFormSyncs,
  runJiandaoyunContractSync,
} from "./sync-jiandaoyun";
import { probeFeishuChats } from "./probe-feishu";
import { runJiandaoyunContractAudit } from "./audit-jiandaoyun";

const USAGE = `用法:
  npx tsx src/jobs/cli.ts reconcile-jst [YYYY-MM-DD]     缺省=昨日（Asia/Shanghai）
  npx tsx src/jobs/cli.ts sync-jst [YYYY-MM-DD]          API 拉取 T-1/指定日到受控 staging
  npx tsx src/jobs/cli.ts sync-jst-inventory             增量库存总量观察到受控 staging（需显式启用）
  npx tsx src/jobs/cli.ts sync-jiandaoyun-catalog        同步可见应用/表单目录（不读取业务行）
  npx tsx src/jobs/cli.ts sync-jiandaoyun-forms          同步显式配置的最小化观察契约
  npx tsx src/jobs/cli.ts sync-jiandaoyun-form <key>     同步一条命名观察契约
  npx tsx src/jobs/cli.ts audit-jiandaoyun-contracts     只读输出九条契约的聚合控制总量
  npx tsx src/jobs/cli.ts probe-feishu-chats              只读列出应用机器人可见群/chat_id
  npx tsx src/jobs/cli.ts license-alert [YYYY-MM-DD]     缺省=今日
  npx tsx src/jobs/cli.ts snapshot-age [YYYY-MM-DD] [阈值天数=3]
  npx tsx src/jobs/cli.ts export-worker                  处理一批待办导出任务
  npx tsx src/jobs/cli.ts housekeeping                   过期数据保洁（staging/导出/错误/任务史）
  npx tsx src/jobs/cli.ts stage-jst <file.xlsx|csv> <userId>`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "probe-feishu-chats") {
    console.log(JSON.stringify(await probeFeishuChats(), null, 2));
    return;
  }
  if (cmd === "audit-jiandaoyun-contracts") {
    console.log(JSON.stringify(await runJiandaoyunContractAudit(), null, 2));
    return;
  }
  const db = await getDbAsync();
  let out: unknown;
  switch (cmd) {
    case "sync-jst":
      out = await runJstSalesSync(db, args[0] ?? shanghaiToday(-1));
      break;
    case "sync-jst-inventory":
      out = await runJstInventorySync(db);
      break;
    case "sync-jiandaoyun-catalog":
      out = await runJiandaoyunCatalogSync(db);
      break;
    case "sync-jiandaoyun-forms":
      out = await runJiandaoyunConfiguredFormSyncs(db);
      break;
    case "sync-jiandaoyun-form":
      if (!args[0]) throw new Error(`sync-jiandaoyun-form 需要 <key>\n${USAGE}`);
      out = await runJiandaoyunContractSync(db, args[0]);
      break;
    case "reconcile-jst":
      out = await runReconcileJst(db, args[0] ?? shanghaiToday(-1));
      break;
    case "license-alert":
      out = await runLicenseAlert(db, args[0]);
      break;
    case "snapshot-age":
      out = await runSnapshotAgeAlert(db, {
        today: args[0],
        thresholdDays: args[1] !== undefined ? Number(args[1]) : undefined,
      });
      break;
    case "export-worker": {
      const results = [];
      let r;
      while ((r = await runExportWorkerOnce(db))) results.push(r);
      out = { processed: results.length, results };
      break;
    }
    case "housekeeping":
      out = await runHousekeeping(db);
      break;
    case "stage-jst": {
      const [file, userId] = args;
      if (!file || !Number.isInteger(Number(userId)) || Number(userId) <= 0) {
        throw new Error(`stage-jst 需要 <file> <userId>\n${USAGE}`);
      }
      out = await stageJstDaily(db, file, Number(userId));
      break;
    }
    default:
      throw new Error(`未知任务: ${cmd ?? "(空)"}\n${USAGE}`);
  }
  console.log(JSON.stringify(out, null, 2));
}

main()
  .then(() => process.exit(0)) // PGlite 持句柄，显式退出
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
