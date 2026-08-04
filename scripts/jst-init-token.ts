/**
 * 聚水潭「自有商城应用」取初始 access_token。
 *
 * `npm run jst:init-token`
 *
 * ⚠ **本项目当前的应用不走这条路**：实测该接口返回 `21024 仅支持自有应用`，
 * 说明我们这个 AppKey 注册的是**服务商应用**，必须走 OAuth 授权页
 * （`npm run jst:auth-url` → 商家登录授权 → code → `jst-exchange-code`）。
 * 保留本脚本是因为：若日后改注册为自有商城应用，这条路无需商家点击、可全自动取 token，
 * 且脚本内置的官方算例自校验对排查签名问题很有用。
 *
 * 关键认知（2026-08-04 查官方文档 docId=23）：
 * 自研应用**没有浏览器授权页**。文档原文：「自有应用审核通过后，会根据用户提交的
 * 资质信息进行**静默授权**，因此可以获得一个初始 access_token」。
 * 参数里的 `code` 不是回调带回来的授权码，而是「随机码（随机创建六位字符串）**自定义值**」
 * ——由调用方自己生成的一次性随机串。
 *
 * 而服务商应用则相反：必须由商家在 `openweb.jushuitan.com/auth?...` 页面登录授权。
 * 两条路的参数集不同，不能互相套用——这正是我最初把两者搞混的地方。
 *
 * 签名（docId=70）：MD5(app_secret + 按键字典序拼接的 key1value1key2value2...)，
 * 32 位小写；排除 sign 与空值；**app_secret 只加在前面**，不是前后各一次。
 * 本脚本启动时先用文档给出的算例自校验，算错就直接停，避免拿错签名去打真实接口。
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

import { signJstParams } from "../src/server/integrations/jst";

/** 文档 docId=70 给出的算例，用于自校验签名实现 */
function selfCheck(): void {
  const expected = "05e3a51e19e0883afd1882ccd309e0b9";
  const actual = signJstParams("e9c5ca33fecb404b8e6cdbd0ef4a6d25", {
    app_key: "5b53060f23d84ddf9703056e84fa5a2d",
    timestamp: "1639128407",
    grant_type: "authorization_code",
    charset: "utf-8",
    code: "123456",
  });
  if (actual !== expected) {
    console.error(`签名自校验失败：期望 ${expected}，实得 ${actual}`);
    console.error("实现与官方算例不一致，先修签名再打真实接口。");
    process.exit(1);
  }
  console.log("✓ 签名实现与官方算例一致");
}

function setEnv(key: string, value: string): void {
  const path = ".env";
  const src = readFileSync(path, "utf8");
  const line = `${key}=${value}`;
  const next = new RegExp(`^${key}=.*$`, "m").test(src)
    ? src.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${src.replace(/\s*$/, "")}\n${line}\n`;
  writeFileSync(path, next);
}

async function main(): Promise<void> {
  selfCheck();

  const appKey = process.env.JST_APP_KEY?.trim();
  const appSecret = process.env.JST_APP_SECRET?.trim();
  if (!appKey || !appSecret) {
    console.error("缺少 JST_APP_KEY / JST_APP_SECRET（应在 .env）");
    process.exit(1);
    return;
  }

  const params: Record<string, string> = {
    app_key: appKey,
    timestamp: String(Math.floor(Date.now() / 1000)),
    grant_type: "authorization_code",
    charset: "utf-8",
    // 文档：随机创建六位字符串，自定义值
    code: randomBytes(3).toString("hex"),
  };
  params.sign = signJstParams(appSecret, params);

  const url = "https://openapi.jushuitan.com/openWeb/auth/getInitToken";
  console.log(`\n请求 ${url}（code=${params.code}）…`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30000),
  });
  const json = (await res.json()) as {
    code?: number; msg?: string;
    data?: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  };

  if (json.code !== 0 || !json.data?.access_token) {
    console.error(`\n✗ 取 token 失败：code=${json.code} msg=${json.msg ?? "(无)"}`);
    console.error("  常见原因：自有应用尚未审核通过（静默授权未生效）、或已过期需走 refreshToken。");
    process.exit(1);
    return;
  }

  setEnv("JST_ACCESS_TOKEN", json.data.access_token);
  if (json.data.refresh_token) setEnv("JST_REFRESH_TOKEN", json.data.refresh_token);
  // 供 token 看门狗计算剩余有效期（30 天）
  setEnv("JST_TOKEN_OBTAINED_AT", new Date().toISOString());

  console.log(`\n✓ access_token 已写入 .env（长度 ${json.data.access_token.length}）`);
  if (json.data.refresh_token) console.log(`  refresh_token 也已写入（长度 ${json.data.refresh_token.length}）`);
  if (json.data.expires_in) {
    console.log(`  有效期 ${json.data.expires_in} 秒（约 ${Math.round(json.data.expires_in / 86400)} 天）`);
  }
  console.log(`  scope=${json.data.scope ?? "(未返回)"}`);
  console.log("\n⚠ 30 天过期，且**过期前 12 小时内**调用 refreshToken 才有效；");
  console.log("  jst-token-watchdog 会在临期时开告警并推到飞书。");
  console.log("\n下一步：npm run readiness 复检，然后跑真实拉数。\n");
}
void main().catch((error) => {
  console.error("失败：", (error as Error).message.slice(0, 300));
  process.exit(1);
});
