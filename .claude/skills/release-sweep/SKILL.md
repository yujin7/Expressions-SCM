---
name: release-sweep
description: Runs the whole-app verification sweep for this supply-chain system — every page, every GET route, hydration fingerprints, migration drift, smoke suite. Use before telling the user a batch of work is done, before any commit touching multiple pages or routes, after restarting the dev server, when the user says the system feels rough or broken or half-finished, and whenever unsure whether something unrelated was broken. The two most expensive defects in this project's history — 24 pages with total hydration failure and a client import that made every route including /api/health return 500 — both passed unit tests and returned HTTP 200, and only this sweep exposed them. Do not use for a single isolated pure-function change with no page or route impact.
---

# 全量扫描

**这个项目最贵的两个 bug 都不是读代码找到的，是扫出来的。** 两个都返回 200，两个都单测全绿：

1. 24 页整页水合失败 —— `page.tsx` 缺 `<Suspense>`，`useId` 序列 SSR/CSR 错位，
   页面退化成无交互静态 HTML（Tab 变纯文字、表头重复、点不动）。
2. `"use client"` 值导入 `@/server/*` —— 把 auth/pg/argon2 拖进客户端包，
   webpack 解析失败后污染模块图，**全应用含 `/api/health` 齐刷刷 500**，且随编译顺序漂移。

只测你改过的地方，这两类永远抓不到。

---

## 顺序（快的先跑，贵的后跑）

```bash
npx tsc --noEmit 2>&1 | /usr/bin/grep -v "\.next/types"   # ~40s
npx vitest run                                            # ~14s
npx tsx scripts/smoke-e2e.ts                              # ~1min，21 项
curl -s localhost:3000/api/health                         # 迁移条数 + drift:false
```

`/api/health` 显示 `drift:true` 或迁移数对不上 → **先重启 dev server**。
PGlite 只在启动时应用迁移，热更新的代码引用新列会全线 500。

---

## 登录（先做，否则后面全是重定向）

**provider id 是 `local`，不是 `credentials`**。走错端点拿到 `error=Configuration`，
看起来像登录坏了——那是脚本错了。

```bash
rm -f /tmp/j.jar
CSRF=$(curl -s -c /tmp/j.jar http://localhost:3000/api/auth/csrf \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrfToken"])')
curl -s -b /tmp/j.jar -c /tmp/j.jar -o /dev/null \
  -X POST "http://localhost:3000/api/auth/callback/local" \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "username=admin" --data-urlencode "password=admin123"
curl -s -b /tmp/j.jar http://localhost:3000/api/auth/session   # 必须返回 user，不能是 null
```

验证脱敏要换角色：`ops01` / `warehouse01` 不该看到任何价格字段。用 admin 看不出 R9 是否生效。

---

## 全页扫描 + 水合指纹

```bash
find "src/app/(app)" -name page.tsx | sed 's|src/app/(app)||; s|/page.tsx||' \
  | sed 's|^$|/|' | sort > /tmp/routes.txt

while read -r p; do
  code=$(curl -s -m 120 -b /tmp/j.jar -o /tmp/pg.html -w "%{http_code}" "http://localhost:3000$p")
  cont=$(/usr/bin/grep -o "ant-table-container" /tmp/pg.html | wc -l | tr -d ' ')
  head=$(/usr/bin/grep -o "ant-table-thead"    /tmp/pg.html | wc -l | tr -d ' ')
  [ "$code" != "200" ] && echo "  $code $p"
  [ "$head" -gt "$cont" ] && echo "  水合疑似 $p (thead=$head > 容器=$cont)"
done < /tmp/routes.txt
```

**判读**：只有 `thead 数 > 表格容器数` 才是水合失败。一页两张表 = 2 容器 2 thead，**正常**。
只数 thead 会误报——上次三条「疑似」全是两张合法表格。

`[id]` 动态路由扫不到，要用真实单号补测（如 `/outsource/po/2/print`）。

---

## 全 API 扫描

```bash
find src/app/api -name route.ts | sed 's|src/app||; s|/route.ts||' | sort | while read -r r; do
  case "$r" in *"["*) continue;; esac
  code=$(curl -s -m 120 -b /tmp/j.jar -o /tmp/api.json -w "%{http_code}" "http://localhost:3000$r")
  [ "$code" = "500" ] && echo "  500 $r :: $(head -c 160 /tmp/api.json)"
done
```

**400 是对的**（缺必填参数的正确响应）。**500 永远是 bug**——即使根因是用户少传参数：
缺参必须 `throw new ApiError(400, ...)`，裸 `Error` 会被兜底成
「系统错误，请联系管理员（错误码 xxx）」并污染 `error_logs`。

---

## 收尾

- 报数字，不报感觉：「71 页全 200，0 处水合指纹，79/88 路由 200（7 个是正确的 400）」。
- 有任何一项没跑，**明说没跑**，不要含糊成「已验证」。
- 这个仓库常有另一个会话同时在写：提交前 `git log --oneline -5` 看有无新提交，
  只 `git add` 自己的文件。中文提交信息含括号会破坏引号，用 `git commit -F`。
