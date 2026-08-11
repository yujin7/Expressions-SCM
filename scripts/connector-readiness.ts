/**
 * 连接器就绪度体检：打印每个三方连接器缺什么、卡在哪一环。
 *
 * 只读、不发请求、不打印任何密钥值（只打印键名）。
 * `npm run readiness`
 *
 * 事故背景（2026-08-03）：曾同时存在 .env 与 .env.local，Next.js 里 .env.local 覆盖 .env，
 * 而临时体检脚本只读 .env —— 于是"体检说没配"和"应用实际在用"是两套值，
 * 简道云明明配好了却被报成缺 API Key。现已统一为单一配置源，本脚本也直接复用
 * Next 的加载器，保持引号、注释、变量展开和优先级语义完全一致。
 */
import { loadJobEnvironment } from "../src/jobs/load-env";
import { getConnectorReadiness } from "../src/server/integrations/connector";

function main(): void {
  loadJobEnvironment();
  const rows = getConnectorReadiness(process.env) as unknown as Record<string, unknown>[];
  for (const o of rows) {
    console.log(`\n── ${String(o.label)} [${String(o.key)}]`);
    console.log(
      `   实现=${String(o.implementation)}  已配置=${String(o.configured)}  ` +
        `配置就绪=${String(o.configurationReady)}  可运行=${String(o.operational)}`,
    );
    console.log(
      `   启用=${String(o.enablementState)}  实测证据=${String(o.liveVerificationState)}  ` +
        `契约=${String(o.contractSelectionState)}(${String(o.selectedContractCount)})`,
    );
    console.log(
      `   身份=${String(o.identityClearanceState)}  待裁决=${String(o.openScopedAliasExceptions ?? "未读取数据库")}  ` +
        `已观察=${String(o.observedScopedIdentities ?? "未读取数据库")}`,
    );
    if (typeof o.blocker === "string" && o.blocker.trim()) {
      console.log(`   下一步: ${o.blocker}`);
    }
    for (const k of ["missingEnv", "blockers", "gaps", "notes"]) {
      const v = o[k];
      if (Array.isArray(v) && v.length) {
        console.log(`   ${k}: ${(v as unknown[]).map(String).join(", ")}`);
      }
    }
  }
  console.log("");
}
main();
