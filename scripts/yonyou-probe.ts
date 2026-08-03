/**
 * 用友只读探针：确认网关可达、能取 token，并逐条报出 8 个业务契约的授权状态。
 *
 * `npm run yy:probe`
 *
 * 只发只读查询（pageSize=2），不写用友任何数据，不打印 token 全文。
 *
 * 判读口径（2026-08-03 实测确立）：
 *  - `310037 API未被授权` ⇒ 网关认得这个 AppKey，但该条 API 没授权给它 → 控制台逐条勾选即可；
 *  - `310005 应用不存在`  ⇒ 打错网关了（该 AppKey 不在这个集群上）。本租户在 c4，
 *    正确网关是 https://c4.yonyoucloud.com/iuap-api-gateway，不是 api.diwork.com。
 *    注意 c4 必须带 /iuap-api-gateway 路径；裸 c4.yonyoucloud.com 取不到 token，
 *    曾据此误判「c4 只是登录门户」，实为路径写漏。
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const APP_KEY = process.env.YY_APP_KEY;
const APP_SECRET = process.env.YY_APP_SECRET;
const GW = (process.env.YY_BASE_URL ?? "https://c4.yonyoucloud.com/iuap-api-gateway").replace(/\/+$/, "");

if (!APP_KEY || !APP_SECRET) {
  console.error("缺少 YY_APP_KEY / YY_APP_SECRET（应在 .env 中）");
  process.exit(1);
}

function sign(params: Record<string, string>): string {
  return createHmac("sha256", APP_SECRET!)
    .update(Object.keys(params).sort().map((k) => `${k}${params[k]}`).join(""), "utf8")
    .digest("base64");
}

async function getToken(): Promise<string> {
  const timestamp = String(Date.now());
  const signature = sign({ appKey: APP_KEY!, timestamp });
  const url = `${GW}/open-auth/selfAppAuth/getAccessToken`
    + `?appKey=${encodeURIComponent(APP_KEY!)}&timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = (await res.json()) as { code?: string; message?: string; data?: { access_token?: string } };
  const token = body.data?.access_token;
  if (!token) throw new Error(`取 token 失败：${body.code ?? "?"} ${body.message ?? JSON.stringify(body).slice(0, 160)}`);
  return token;
}

/** 与 src/server/integrations/yonyou-contracts.ts 的只读契约保持一致 */
const CONTRACTS: readonly (readonly [string, string])[] = [
  ["分页查询当前租户组织架构", "/yonbip/uspace/org/page_list"],
  ["供应商档案列表查询", "/yonbip/digitalModel/vendor/list"],
  ["物料档案分页查询 V2", "/yonbip/digitalModel/product/listproductbycondition"],
  ["采购订单列表查询", "/yonbip/scm/purchaseorder/list"],
  ["采购入库列表查询", "/yonbip/scm/purinrecord/list"],
  ["现存量查询 V2", "/yonbip/scm/stock/QueryCurrentStocksByCondition"],
  ["存货成本查询", "/yonbip/EFI/fieia/queryBalance"],
  ["凭证列表查询", "/yonbip/fi/ficloud/openapi/voucher/queryVouchers"],
];

async function main(): Promise<void> {
  console.log(`\n网关：${GW}`);
  let token: string;
  try {
    token = await getToken();
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
    return;
  }
  console.log(`✓ 鉴权通过（token 长度 ${token.length}）\n`);

  const granted: string[] = [];
  const wrongGateway: string[] = [];
  for (const [name, path] of CONTRACTS) {
    let line: string;
    try {
      const res = await fetch(`${GW}${path}?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageIndex: 1, pageSize: 2 }),
        signal: AbortSignal.timeout(20000),
      });
      const text = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
      if (/310037|未获得.*授权/.test(text)) line = "✗ 未授权";
      else if (/310005|应用.*不存在/.test(text)) { line = "✗ 网关不符"; wrongGateway.push(name); }
      else { line = "✓ 已授权"; granted.push(name); }
      console.log(` ${line}  ${name}`);
      if (line === "✓ 已授权") console.log(`          ↳ ${text}`);
    } catch (e) {
      console.log(` ✗ 异常    ${name}：${(e as Error).message.slice(0, 60)}`);
    }
  }

  console.log(`\n═══ 已授权 ${granted.length}/${CONTRACTS.length} ═══`);
  if (wrongGateway.length) {
    console.log("⚠ 出现「应用不存在」——多半是 YY_BASE_URL 指向了别的集群。");
    console.log("  本租户应为 https://c4.yonyoucloud.com/iuap-api-gateway");
  }
  if (granted.length < CONTRACTS.length) {
    console.log("未授权项需在用友开放平台给该 AppKey 逐条勾选 API 授权后重跑本探针。");
  }
  console.log("");
}
void main();
