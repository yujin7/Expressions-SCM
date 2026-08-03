/**
 * 用授权 code 换聚水潭 access_token（OAuth 第二步），并把结果写回 .env。
 *
 * 用法：npx tsx scripts/jst-exchange-code.ts <授权回调里的 code>
 *
 * 只写 .env（已确认 gitignore、不入库）。token 不打印全文，只打印长度与到期信息。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { signJstParams } from "../src/server/integrations/jst";

for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] ??= m[2];
}

const APP_KEY = process.env.JST_APP_KEY;
const APP_SECRET = process.env.JST_APP_SECRET;
const code = process.argv[2];

if (!APP_KEY || !APP_SECRET) {
  console.error("缺少 JST_APP_KEY / JST_APP_SECRET");
  process.exit(1);
}
if (!code) {
  console.error("用法：npx tsx scripts/jst-exchange-code.ts <code>\n先运行 npx tsx scripts/jst-auth-url.ts 生成授权链接。");
  process.exit(1);
}

function setEnv(key: string, value: string): void {
  const path = ".env";
  const src = readFileSync(path, "utf8");
  const re = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(path, re.test(src) ? src.replace(re, `${key}=${value}`) : `${src.replace(/\s*$/, "")}\n${key}=${value}\n`, "utf8");
}

async function main(): Promise<void> {
  const params: Record<string, string> = {
    app_key: APP_KEY!,
    charset: "utf-8",
    timestamp: String(Math.floor(Date.now() / 1000)),
    version: "2",
    code,
    grant_type: "authorization_code",
  };
  params.sign = signJstParams(APP_SECRET!, params);

  const res = await fetch("https://openapi.jushuitan.com/openWeb/auth/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch { /* 非 JSON，原样报错 */ }

  const data = (parsed?.data ?? parsed) as Record<string, unknown> | undefined;
  const token = typeof data?.access_token === "string" ? data.access_token : null;

  if (!token) {
    console.error(`换取失败（HTTP ${res.status}）：${text.slice(0, 400)}`);
    console.error("\ncode 仅 15 分钟有效；若已过期请重新运行 scripts/jst-auth-url.ts。");
    process.exit(1);
  }

  setEnv("JST_ACCESS_TOKEN", token);
  if (typeof data?.refresh_token === "string") setEnv("JST_REFRESH_TOKEN", data.refresh_token);

  console.log(`✓ access_token 已写入 .env（长度 ${token.length}）`);
  if (data?.expires_in) console.log(`  有效期：${String(data.expires_in)} 秒`);
  if (data?.refresh_token) console.log("  refresh_token 也已写入");
  console.log("\n下一步：npm run readiness 复检；随后可跑真实拉数联调。");
}
void main();
