/**
 * 生成聚水潭商家授权链接（OAuth 第一步）。
 *
 * 聚水潭开放接口是 OAuth 模式：光有 APP Key/Secret 不够，还需要商家（你们自己的聚水潭账号）
 * 授权这个应用，换出 access_token。本脚本只做签名和拼串，不发任何请求、不碰账号口令。
 *
 * 用法：
 *   npm run jst:auth-url
 * 然后用你们的聚水潭账号打开输出的链接 → 同意授权 → 回调地址上会带 code 参数
 * （code 仅 15 分钟有效），再用 `npx tsx scripts/jst-exchange-code.ts <code>` 换 token。
 *
 * 签名一律复用 `src/server/integrations/jst.ts` 的 signJstParams——不要在这里另写一份。
 * 该实现已被服务端证明正确：用它调业务接口返回的是 `130 入参缺少access_token`
 * 而不是 `120 验证失败!无效签名`，说明签名这一关是过的。
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

import { signJstParams } from "../src/server/integrations/jst";

const APP_KEY = process.env.JST_APP_KEY;
const APP_SECRET = process.env.JST_APP_SECRET;
if (!APP_KEY || !APP_SECRET) {
  console.error("缺少 JST_APP_KEY / JST_APP_SECRET（应在 .env 中）");
  process.exit(1);
}

const params: Record<string, string> = {
  app_key: APP_KEY,
  charset: "utf-8",
  version: "2",
  timestamp: String(Math.floor(Date.now() / 1000)),
  // state 原样回传，用于校验回调确实来自本次请求
  state: "scm-auth",
};
params.sign = signJstParams(APP_SECRET, params);

const url = `https://openweb.jushuitan.com/auth?${new URLSearchParams(params).toString()}`;

console.log("\n═══ 聚水潭商家授权链接（15 分钟内使用）═══\n");
console.log(url);
console.log("\n步骤：");
console.log("  1. 用你们的聚水潭账号打开上面的链接；");
console.log("  2. 确认授权范围后点「同意授权」；");
console.log("  3. 跳转后地址栏会带 code=xxxx，把这个 code 发给我，或直接运行：");
console.log("     npx tsx scripts/jst-exchange-code.ts <code>");
console.log("\n注意：code 仅 15 分钟有效，过期需重新生成本链接。\n");
