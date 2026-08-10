/**
 * 用友只读探针：确认网关可达、能取 token，并逐条报出契约的授权状态。
 *
 * `npm run yy:probe`
 *
 * 签名与调用一律走 `src/server/integrations/yonyou-client.ts` 的 YonyouClient——
 * 不在本文件另写一份。（教训：聚水潭那边我曾在脚本里另写签名，算法与权威实现不同，
 * 属于本仓一直在防的「同一口径两处实现」。）
 *
 * 判读口径（2026-08-03 实测确立）：
 *  - `310037 API未被授权` ⇒ 网关认得这个 AppKey，但该条 API 没授权给它 → 控制台逐条勾选即可；
 *  - `310005 应用不存在`  ⇒ 打错网关了（该 AppKey 不在这个集群上）。本租户在 c4，
 *    正确网关是 https://c4.yonyoucloud.com/iuap-api-gateway，**必须带 /iuap-api-gateway 路径**；
 *    裸 c4.yonyoucloud.com 取不到 token，曾据此误判「c4 只是登录门户」，实为路径写漏。
 *
 * 探针刻意把契约表里全部 8 条都试一遍（而不是只试 YY_APPROVED_API_CONTRACTS 选中的），
 * 这样授权进度一目了然；路径仍只来自代码评审过的契约表，不接受任意 path。
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

import { YonyouClient } from "../src/server/integrations/yonyou-client";
import { YONYOU_READ_CONTRACTS } from "../src/server/integrations/yonyou-contracts";
import { parseYonyouAllowedHosts, parseYonyouProductProfile } from "../src/server/integrations/yonyou";

const APP_KEY = process.env.YY_APP_KEY?.trim();
const APP_SECRET = process.env.YY_APP_SECRET?.trim();
const BASE_URL = process.env.YY_BASE_URL?.trim() ?? "https://c4.yonyoucloud.com/iuap-api-gateway";
const TOKEN_URL = process.env.YY_TOKEN_URL?.trim()
  ?? "https://c4.yonyoucloud.com/iuap-api-gateway/open-auth/selfAppAuth/getAccessToken";

if (!APP_KEY || !APP_SECRET) {
  console.error("缺少 YY_APP_KEY / YY_APP_SECRET（应在 .env 中）");
  process.exit(1);
}

const allowedHosts = parseYonyouAllowedHosts(process.env.YY_ALLOWED_HOSTS) ?? ["c4.yonyoucloud.com"];

// 探针不需要 tenant/org（那两个正是授权后才拿得到的），故直接构造配置而不过 yonyouConfigFromEnv。
const client = new YonyouClient({
  appKey: APP_KEY,
  appSecret: APP_SECRET,
  tenantId: process.env.YY_TENANT_ID?.trim() || "probe",
  orgId: process.env.YY_ORG_ID?.trim() || "probe",
  productProfile: parseYonyouProductProfile(process.env.YY_PRODUCT_PROFILE) ?? "c4",
  approvedApiContracts: YONYOU_READ_CONTRACTS.map((contract) => contract.name),
  allowedHosts,
  baseUrl: BASE_URL,
  tokenUrl: TOKEN_URL,
}, { retries: 0 });

async function main(): Promise<void> {
  console.log(`\n网关：${BASE_URL}`);
  try {
    const token = await client.getAccessToken();
    console.log(`✓ 鉴权通过（token 长度 ${token.length}）\n`);
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(1);
    return;
  }

  const results = await client.probeApprovedContracts();
  let wrongGateway = false;
  for (const row of results) {
    if (row.code === "310005") wrongGateway = true;
    const tag = row.granted ? "✓ 已授权" : row.code === "310005" ? "✗ 网关不符" : "✗ 未授权";
    console.log(` ${tag}  ${row.name}`);
  }

  const granted = results.filter((row) => row.granted).length;
  console.log(`\n═══ 已授权 ${granted}/${results.length} ═══`);
  if (wrongGateway) {
    console.log("⚠ 出现「应用不存在」——多半是 YY_BASE_URL 指向了别的集群。");
    console.log("  本租户应为 https://c4.yonyoucloud.com/iuap-api-gateway");
  }
  if (granted < results.length) {
    console.log("未授权项需在用友开放平台给该 AppKey 逐条勾选 API 授权后重跑本探针。");
  } else {
    console.log("全部授权到位——可继续读取租户/组织并跑真实对账。");
  }
  console.log("");
}
void main();
