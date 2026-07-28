/**
 * HTTP 冒烟（只读——任何时候可安全运行，不写库）：对一台【已运行】的服务器逐项探测。
 *   npx tsx scripts/smoke-e2e.ts            # 默认 http://localhost:3000
 *   SMOKE_BASE=https://host npx tsx scripts/smoke-e2e.ts
 * 覆盖：健康检查（迁移无漂移）、全角色登录、关键只读端点形状、越权/匿名负样例、
 * ops 角色 PO 价格脱敏。退出码 0=全过 / 1=有失败；结尾打印汇总表。
 * 口令：可提供统一的 SMOKE_PASSWORD；若管理员与角色账号不同，则同时提供
 * SMOKE_ADMIN_PASSWORD 与 SMOKE_ROLE_PASSWORD；质量账号若另设口令，可再提供
 * SMOKE_QUALITY_PASSWORD。脚本不保留任何公开默认密码。
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const SHARED_PASSWORD = process.env.SMOKE_PASSWORD?.trim() ?? "";
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD?.trim() || SHARED_PASSWORD;
const ROLE_PASSWORD = process.env.SMOKE_ROLE_PASSWORD?.trim() || SHARED_PASSWORD;
const QUALITY_PASSWORD = process.env.SMOKE_QUALITY_PASSWORD?.trim() || ROLE_PASSWORD;
const ROLE_USERS = [
  "admin",
  "ops01",
  "purchasing01",
  "warehouse01",
  "quality01",
  "pmc01",
  "finance01",
];

type Status = "PASS" | "FAIL" | "SKIP";
const results: { name: string; status: Status; detail: string }[] = [];
function record(name: string, status: Status, detail = ""): void {
  results.push({ name, status, detail });
  const icon = status === "PASS" ? "✓" : status === "SKIP" ? "→" : "✗";
  console.log(`${icon} [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** 极简 cookie jar（next-auth 需要 csrf + session cookie 往返） */
class Jar {
  private cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === "" || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
  }
  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function jarFetch(jar: Jar, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    redirect: "manual",
    headers: { ...(init?.headers ?? {}), cookie: jar.header() },
  });
  jar.absorb(res);
  return res;
}

/** next-auth credentials 登录（provider id="local"）：GET csrf → POST callback/local；失败返回 null */
async function login(username: string, password: string): Promise<Jar | null> {
  try {
    const jar = new Jar();
    const csrfRes = await jarFetch(jar, "/api/auth/csrf");
    const { csrfToken } = (await csrfRes.json().catch(() => ({}))) as { csrfToken?: string };
    if (!csrfToken) return null;
    const res = await jarFetch(jar, "/api/auth/callback/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, username, password }).toString(),
    });
    const loc = res.headers.get("location") ?? "";
    if (res.status !== 302 || /error=/i.test(loc)) return null;
    // 校验会话真实生效
    const me = await jarFetch(jar, "/api/me");
    return me.status === 200 ? jar : null;
  } catch {
    return null;
  }
}

/** 递归查找对象树中是否存在某键 */
function hasDeepKey(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasDeepKey(x, key));
  if (v !== null && typeof v === "object") {
    if (key in (v as Record<string, unknown>)) return true;
    return Object.values(v as Record<string, unknown>).some((x) => hasDeepKey(x, key));
  }
  return false;
}

async function getJson(jar: Jar | null, path: string): Promise<{ status: number; body: unknown }> {
  const res = jar
    ? await jarFetch(jar, path)
    : await fetch(`${BASE}${path}`, { redirect: "manual" });
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main(): Promise<void> {
  if (!ADMIN_PASSWORD || !ROLE_PASSWORD) {
    throw new Error(
      "必须显式设置 SMOKE_PASSWORD，或同时设置 SMOKE_ADMIN_PASSWORD 与 SMOKE_ROLE_PASSWORD；拒绝使用公开默认密码",
    );
  }
  console.log(`冒烟目标: ${BASE}\n`);

  // 1) 健康检查：ok 且迁移文件数===已应用数（PGlite 模式）
  {
    const { status, body } = await getJson(null, "/api/health");
    const h = body as { ok?: boolean; migrationFiles?: number; applied?: number } | null;
    if (status === 200 && h?.ok === true && (h.applied === -2 || h.migrationFiles === h.applied)) {
      record("健康检查 /api/health", "PASS", `migrations ${h.applied}/${h.migrationFiles}`);
    } else {
      record("健康检查 /api/health", "FAIL", `status=${status} body=${JSON.stringify(body)}`);
    }
  }

  // 2) 各角色登录
  const jars = new Map<string, Jar>();
  for (const u of ROLE_USERS) {
    const password = u === "admin"
      ? ADMIN_PASSWORD
      : u === "quality01"
        ? QUALITY_PASSWORD
        : ROLE_PASSWORD;
    const jar = await login(u, password);
    if (jar) {
      jars.set(u, jar);
      record(`登录 ${u}`, "PASS");
    } else {
      record(`登录 ${u}`, "FAIL", "凭证登录未取得会话");
    }
  }
  const admin = jars.get("admin");
  const ops = jars.get("ops01");
  const quality = jars.get("quality01");
  if (!admin) {
  printSummary();
    process.exit(1);
  }

  // 3) 关键只读端点（admin 视角）
  const dash = await getJson(admin, "/api/report/dashboard");
  {
    const kpi = (dash.body as { kpi?: Record<string, unknown> } | null)?.kpi;
    const need = ["skuActive", "spuCount", "ownStockQty", "pendingApprovals", "reviewBacklog"];
    const missing = need.filter((k) => !(kpi && k in kpi));
    if (dash.status === 200 && missing.length === 0) record("驾驶舱 /api/report/dashboard", "PASS", "kpi 键齐全");
    else record("驾驶舱 /api/report/dashboard", "FAIL", `status=${dash.status} 缺键=${missing.join(",")}`);
  }
  {
    const { status, body } = await getJson(admin, "/api/inventory/balance");
    const total = (body as { total?: number } | null)?.total;
    if (status === 200 && typeof total === "number" && total >= 0) record("库存余额 /api/inventory/balance", "PASS", `total=${total}`);
    else record("库存余额 /api/inventory/balance", "FAIL", `status=${status} total=${String(total)}`);
  }
  {
    const { status, body } = await getJson(admin, "/api/replenish/suggestions");
    const total = (body as { total?: number } | null)?.total;
    if (status === 200 && typeof total === "number") record("补货建议 /api/replenish/suggestions", "PASS", `total=${total}`);
    else record("补货建议 /api/replenish/suggestions", "FAIL", `status=${status}`);
  }
  {
    const { status, body } = await getJson(admin, "/api/report/transit?kind=fg_order");
    const total = (body as { total?: number } | null)?.total;
    if (status === 200 && typeof total === "number") record("在途参考 /api/report/transit?kind=fg_order", "PASS", `total=${total}`);
    else record("在途参考 /api/report/transit?kind=fg_order", "FAIL", `status=${status}`);
  }
  {
    const { status, body } = await getJson(admin, "/api/review/checklist/counts");
    const ok = status === 200 && body !== null && typeof body === "object";
    record("复核清单计数 /api/review/checklist/counts", ok ? "PASS" : "FAIL", ok ? JSON.stringify(body).slice(0, 80) : `status=${status}`);
  }
  {
    const { status, body } = await getJson(admin, "/api/inbox");
    const total = (body as { total?: number } | null)?.total;
    if (status === 200 && typeof total === "number") record("收件箱 /api/inbox", "PASS", `total=${total}`);
    else record("收件箱 /api/inbox", "FAIL", `status=${status}`);
  }
  {
    const { status, body } = await getJson(admin, "/api/workbench");
    const ok = status === 200 && body !== null && typeof body === "object";
    record("工作台 /api/workbench", ok ? "PASS" : "FAIL", `status=${status}`);
  }
  {
    const { status, body } = await getJson(admin, "/api/quality/cases?page=1&pageSize=1");
    const payload = body as {
      rows?: unknown[];
      total?: number;
      summary?: Record<string, unknown>;
    } | null;
    const ok = status === 200
      && Array.isArray(payload?.rows)
      && typeof payload?.total === "number"
      && payload?.summary !== null
      && typeof payload?.summary === "object";
    record("质量案件 /api/quality/cases", ok ? "PASS" : "FAIL", `status=${status} total=${String(payload?.total)}`);
  }
  {
    const { status, body } = await getJson(admin, "/api/quality/regulatory");
    record(
      "监管证据 /api/quality/regulatory",
      status === 200 && Array.isArray(body) ? "PASS" : "FAIL",
      `status=${status}`,
    );
  }
  {
    const { status, body } = await getJson(admin, "/api/quality/labels");
    record(
      "电子标签 /api/quality/labels",
      status === 200 && Array.isArray(body) ? "PASS" : "FAIL",
      `status=${status}`,
    );
  }
  if (quality) {
    const { status, body } = await getJson(quality, "/api/quality/cases?page=1&pageSize=1");
    const rows = (body as { rows?: unknown[] } | null)?.rows;
    record(
      "质量角色 → /api/quality/cases 可读",
      status === 200 && Array.isArray(rows) ? "PASS" : "FAIL",
      `status=${status}`,
    );
  } else {
    record("质量角色 → /api/quality/cases 可读", "SKIP", "quality01 登录失败");
  }
  {
    const { status, body } = await getJson(admin, "/api/admin/params");
    const rows = (body as { rows?: unknown[] } | null)?.rows;
    if (status === 200 && Array.isArray(rows)) record("运行参数 /api/admin/params", "PASS", `rows=${rows.length}`);
    else record("运行参数 /api/admin/params", "FAIL", `status=${status}`);
  }

  // 4) 负样例
  if (ops) {
    const { status } = await getJson(ops, "/api/admin/users");
    record("越权 ops01 → /api/admin/users 应 403", status === 403 ? "PASS" : "FAIL", `status=${status}`);
  } else {
    record("越权 ops01 → /api/admin/users 应 403", "SKIP", "ops01 登录失败");
  }
  if (quality) {
    const { status } = await getJson(quality, "/api/admin/users");
    record("越权 quality01 → /api/admin/users 应 403", status === 403 ? "PASS" : "FAIL", `status=${status}`);
  } else {
    record("越权 quality01 → /api/admin/users 应 403", "SKIP", "quality01 登录失败");
  }
  {
    const { status } = await getJson(null, "/api/report/dashboard");
    record("匿名 → /api/report/dashboard 应 401", status === 401 ? "PASS" : "FAIL", `status=${status}`);
  }
  {
    const { status } = await getJson(null, "/api/quality/cases?pageSize=1");
    record("匿名 → /api/quality/cases 应 401", status === 401 ? "PASS" : "FAIL", `status=${status}`);
  }
  {
    const { status } = await getJson(null, "/api/public/e-label/not-a-real-token");
    record("无效公开电子标签应 404", status === 404 ? "PASS" : "FAIL", `status=${status}`);
  }
  {
    const { status } = await getJson(null, "/api/import/jobs?pageSize=1");
    record("匿名 → /api/import/jobs 应 401", status === 401 ? "PASS" : "FAIL", `status=${status}`);
  }
  if (ops) {
    const { status } = await getJson(ops, "/api/import/jobs?pageSize=1");
    record("越权 ops01 → /api/import/jobs 应 403", status === 403 ? "PASS" : "FAIL", `status=${status}`);
  } else {
    record("越权 ops01 → /api/import/jobs 应 403", "SKIP", "ops01 登录失败");
  }
  {
    const { status, body } = await getJson(admin, "/api/import/jobs?pageSize=1");
    const data = (body as { data?: unknown[] } | null)?.data;
    record(
      "管理员 → /api/import/jobs 可读",
      status === 200 && Array.isArray(data) ? "PASS" : "FAIL",
      `status=${status}`,
    );
  }

  // 5) PO 详情价格脱敏（ops 不可见 price；admin 对同一 PO 必须可见 price）
  if (ops) {
    const adminPoList = await getJson(admin, "/api/outsource/po");
    const adminRows = (adminPoList.body as { rows?: Array<{ id?: number }> } | null)?.rows ?? [];
    if (adminPoList.status !== 200) {
      record("PO 详情脱敏（admin 有 price / ops01 无 price）", "FAIL", `列表 status=${adminPoList.status}`);
    } else if (adminRows.length === 0) {
      record("PO 详情脱敏（admin 有 price / ops01 无 price）", "SKIP", "无 PO 数据，无法验证");
    } else {
      const poId = Number(adminRows[0]?.id);
      if (!Number.isInteger(poId) || poId <= 0) {
        record("PO 详情脱敏（admin 有 price / ops01 无 price）", "FAIL", "列表首行缺少有效 PO id");
      } else {
        const [adminDetail, opsDetail] = await Promise.all([
          getJson(admin, `/api/outsource/po/${poId}`),
          getJson(ops, `/api/outsource/po/${poId}`),
        ]);
        const adminHasPrice = hasDeepKey(adminDetail.body, "price");
        const opsHasPrice = hasDeepKey(opsDetail.body, "price");
        if (adminDetail.status !== 200 || opsDetail.status !== 200) {
          record(
            "PO 详情脱敏（admin 有 price / ops01 无 price）",
            "FAIL",
            `admin=${adminDetail.status} ops=${opsDetail.status}`,
          );
        } else if (!adminHasPrice) {
          record("PO 详情脱敏（admin 有 price / ops01 无 price）", "FAIL", "admin 详情缺少价格对照字段");
        } else if (opsHasPrice) {
          record("PO 详情脱敏（admin 有 price / ops01 无 price）", "FAIL", "ops01 详情报文发现 price 键");
        } else {
          record("PO 详情脱敏（admin 有 price / ops01 无 price）", "PASS", `poId=${poId}`);
        }
      }
    }
  } else {
    record("PO 详情脱敏（admin 有 price / ops01 无 price）", "SKIP", "ops01 登录失败");
  }

  /* ── Wave V：新页 API 冒烟（risk/expiry/npd） ── */
  if (admin) {
    const risk = await getJson(admin, "/api/report/risk?pageSize=1");
    const riskTotal = (risk.body as { total?: number } | null)?.total;
    record("风险处置 API", riskTotal != null ? "PASS" : "FAIL", `total=${riskTotal}`);
    const exp = await getJson(admin, "/api/inventory/expiry?pageSize=1");
    const expTotal = (exp.body as { total?: number } | null)?.total;
    record("效期批次 API", expTotal != null ? "PASS" : "FAIL", `total=${expTotal}`);
    const npd = await getJson(admin, "/api/npd/projects");
    const projects = (npd.body as { projects?: unknown[] } | null)?.projects;
    record("NPD 项目 API", Array.isArray(projects) ? "PASS" : "FAIL", `projects=${projects?.length ?? "?"}`);
  } else {
    record("新页 API 冒烟", "SKIP", "admin 登录失败");
  }


  printSummary();
  process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
}

function printSummary(): void {
  const w = Math.max(...results.map((r) => r.name.length)) + 2;
  console.log("\n===== 冒烟汇总 =====");
  for (const r of results) console.log(`${r.status.padEnd(5)} ${r.name.padEnd(w)} ${r.detail}`);
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  console.log(`合计: ${results.length} 项 — 通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`);
}

main().catch((e: unknown) => {
  console.error("冒烟执行异常:", e instanceof Error ? e.message : e);
  process.exit(1);
});
