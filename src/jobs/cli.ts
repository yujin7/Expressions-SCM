/**
 * 后台任务 CLI（PGlite 开发模式下 pg_boss 不可用——任务须可独立手跑）：
 *   npx tsx src/jobs/cli.ts reconcile-jst [YYYY-MM-DD]   # 缺省=昨日（Asia/Shanghai）
 *   npx tsx src/jobs/cli.ts sync-jst [YYYY-MM-DD]        # API 拉取到受控 staging
 *   npx tsx src/jobs/cli.ts sync-jst-inventory           # 增量库存观察到受控 staging
 *   npx tsx src/jobs/cli.ts sync-jst-item-master [day]   # 商品身份/生命周期观察
 *   npx tsx src/jobs/cli.ts sync-jst-inbound [day]       # 采购入库观察（不入账）
 *   npx tsx src/jobs/cli.ts license-alert [YYYY-MM-DD]   # 缺省=今日
 *   npx tsx src/jobs/cli.ts procurement-quality-alerts  # 采购与质量四类告警
 *   npx tsx src/jobs/cli.ts stage-jst <file.xlsx|csv> <userId>
 * 输出 JSON summary；失败退出码非 0。
 */
import { getDbAsync } from "@/db";
import { runReconcileJst, shanghaiToday } from "./reconcile-jst";
import { runLicenseAlert } from "./license-alert";
import { runProcurementQualityAlerts } from "./procurement-quality-alerts";
import { runSnapshotAgeAlert } from "./snapshot-age";
import { runExportWorkerOnce } from "./export-worker";
import { runHousekeeping } from "./housekeeping";
import { stageJstDaily } from "@/server/import/adapters/jst-daily";
import {
  runJstGovernedObservationSync,
  runJstInventorySync,
  runJstSalesSync,
} from "./sync-jst";
import { runYonyouSync } from "./sync-yonyou";
import { runJstTokenWatchdog } from "./jst-token-watchdog";
import { runJobFailureWatchdog } from "./job-failure-watchdog";
import { runSystemAlertNotify } from "./system-alert-notify";
import { runDataProductGateWatchdog } from "./data-product-gate-watchdog";
import {
  runJiandaoyunCatalogSync,
  runJiandaoyunConfiguredFormSyncs,
  runJiandaoyunContractSync,
} from "./sync-jiandaoyun";
import { probeFeishuChats } from "./probe-feishu";
import { runJiandaoyunContractAudit } from "./audit-jiandaoyun";
import { auditYonyouReadiness } from "./audit-yonyou";
import { auditConnectorReadiness } from "./audit-connectors";
import { probeJstReadiness } from "./probe-jst";
import { runYonyouPermissionProbe } from "./probe-yonyou";
import { loadJobEnvironment } from "./load-env";
import { runNamedIntervalJobOnce } from "./interval-runner";

loadJobEnvironment();

const USAGE = `用法:
  npx tsx src/jobs/cli.ts reconcile-jst [YYYY-MM-DD]     缺省=昨日（Asia/Shanghai）
  npx tsx src/jobs/cli.ts sync-jst [YYYY-MM-DD]          API 拉取 T-1/指定日到受控 staging
  npx tsx src/jobs/cli.ts sync-jst-inventory             增量库存总量观察到受控 staging（需显式启用）
  npx tsx src/jobs/cli.ts sync-jst-item-master [YYYY-MM-DD] 商品身份/生命周期观察（需显式选契约）
  npx tsx src/jobs/cli.ts sync-jst-inbound [YYYY-MM-DD]  采购入库观察，不写库存账（需显式选契约）
  npx tsx src/jobs/cli.ts sync-yonyou [YYYY-MM-DD]       按已批准契约拉取用友只读观测到受控 staging
  npx tsx src/jobs/cli.ts jst-token-watchdog             检查聚水潭 token 有效期，临期开告警
  npx tsx src/jobs/cli.ts job-failure-watchdog           定时任务连续失败开告警，恢复后自动关闭
  npx tsx src/jobs/cli.ts system-alert-notify            把未处理系统告警推进发件箱（飞书/站内）
  npx tsx src/jobs/cli.ts data-product-gate-watchdog      已批准数据产品失效时开责任域告警
  npx tsx src/jobs/cli.ts sync-jiandaoyun-catalog        同步可见应用/表单目录（不读取业务行）
  npx tsx src/jobs/cli.ts sync-jiandaoyun-forms          同步显式配置的最小化观察契约
  npx tsx src/jobs/cli.ts sync-jiandaoyun-form <key>     同步一条命名观察契约
  npx tsx src/jobs/cli.ts audit-jiandaoyun-contracts [契约key ...]  全量或定向输出聚合控制总量
  npx tsx src/jobs/cli.ts probe-feishu-chats              只读检查应用/权限聚合并列出可见群/chat_id
  npx tsx src/jobs/cli.ts audit-yonyou-readiness          只读检查用友配置/授权前置，不请求 token
  npx tsx src/jobs/cli.ts audit-connectors                 只读汇总全部连接器/UAT 证据，不输出秘密
  npx tsx src/jobs/cli.ts probe-jst [YYYY-MM-DD]            只读验证聚水潭签名与 6 个最小读取面
  npx tsx src/jobs/cli.ts probe-yonyou                       只读验证用友 token 与 8 条代码白名单权限
  npx tsx src/jobs/cli.ts run-job <已登记任务名>          运维手跑定时任务并写 job_runs（失败退出非 0）
  npx tsx src/jobs/cli.ts license-alert [YYYY-MM-DD]     缺省=今日
  npx tsx src/jobs/cli.ts procurement-quality-alerts    证照/交期违约/OTIF 崩塌/质量案件逾期
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
    console.log(JSON.stringify(await runJiandaoyunContractAudit({ contractKeys: args }), null, 2));
    return;
  }
  if (cmd === "audit-yonyou-readiness") {
    console.log(JSON.stringify(auditYonyouReadiness(), null, 2));
    return;
  }
  if (cmd === "audit-connectors") {
    console.log(JSON.stringify(auditConnectorReadiness(), null, 2));
    return;
  }
  if (cmd === "probe-jst") {
    console.log(JSON.stringify(await probeJstReadiness({ bizDate: args[0] }), null, 2));
    return;
  }
  if (cmd === "probe-yonyou") {
    console.log(JSON.stringify(await runYonyouPermissionProbe(), null, 2));
    return;
  }
  const db = await getDbAsync();
  let out: unknown;
  switch (cmd) {
    case "run-job":
      if (!args[0]) throw new Error(`run-job 需要 <已登记任务名>\n${USAGE}`);
      out = await runNamedIntervalJobOnce(args[0], db);
      break;
    case "sync-jst":
      out = await runJstSalesSync(db, args[0] ?? shanghaiToday(-1));
      break;
    case "sync-jst-inventory":
      out = await runJstInventorySync(db);
      break;
    case "sync-jst-item-master":
      out = await runJstGovernedObservationSync(
        db,
        "item-master",
        args[0] ?? shanghaiToday(-1),
      );
      break;
    case "sync-jst-inbound":
      out = await runJstGovernedObservationSync(
        db,
        "inbound-receipts-daily",
        args[0] ?? shanghaiToday(-1),
      );
      break;
    case "system-alert-notify":
      out = await runSystemAlertNotify(db);
      break;
    case "data-product-gate-watchdog":
      out = await runDataProductGateWatchdog(db);
      break;
    case "job-failure-watchdog":
      out = await runJobFailureWatchdog(db);
      break;
    case "jst-token-watchdog":
      out = await runJstTokenWatchdog(db);
      break;
    case "sync-yonyou":
      out = await runYonyouSync(db, args[0] ?? shanghaiToday(-1));
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
    case "procurement-quality-alerts":
      out = await runProcurementQualityAlerts(db);
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
