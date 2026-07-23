/**
 * 后台任务 CLI（PGlite 开发模式下 pg_boss 不可用——任务须可独立手跑）：
 *   npx tsx src/jobs/cli.ts reconcile-jst [YYYY-MM-DD]   # 缺省=昨日（Asia/Shanghai）
 *   npx tsx src/jobs/cli.ts license-alert [YYYY-MM-DD]   # 缺省=今日
 *   npx tsx src/jobs/cli.ts stage-jst <file.xlsx|csv> <userId>
 * 输出 JSON summary；失败退出码非 0。
 */
import { getDbAsync } from "@/db";
import { runReconcileJst, shanghaiToday } from "./reconcile-jst";
import { runLicenseAlert } from "./license-alert";
import { stageJstDaily } from "@/server/import/adapters/jst-daily";

const USAGE = `用法:
  npx tsx src/jobs/cli.ts reconcile-jst [YYYY-MM-DD]     缺省=昨日（Asia/Shanghai）
  npx tsx src/jobs/cli.ts license-alert [YYYY-MM-DD]     缺省=今日
  npx tsx src/jobs/cli.ts stage-jst <file.xlsx|csv> <userId>`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const db = await getDbAsync();
  let out: unknown;
  switch (cmd) {
    case "reconcile-jst":
      out = await runReconcileJst(db, args[0] ?? shanghaiToday(-1));
      break;
    case "license-alert":
      out = await runLicenseAlert(db, args[0]);
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
