# 验证手册

> 目录：分层门禁 · 登录（provider=local）· 全页扫描（水合指纹）· 全 API 扫描 ·
> 数据库直查 · 迁移后必做 · 并发会话 · grep 陷阱 · 验证的元教训

> **纪律：说「做完了」之前必须跑过。** 本页的每条命令都在真实排查中抓到过真 bug。
> 顺序是设计过的——快的先跑，贵的后跑。

---

## 分层门禁

| 门 | 命令 | 抓什么 | 耗时 |
|---|---|---|---|
| 1 类型 | `npx tsc --noEmit` | 类型错、改错字段名、补丁里混进字面 `\n` | ~40s |
| 2 单测 | `npx vitest run` | 规则/服务/过账/红队回归 | ~13s（并行） |
| 3 冒烟 | `npx tsx scripts/smoke-e2e.ts` | 端到端 21 项：登录、角色脱敏、401、各域 API | ~1min |
| 4 健康 | `curl -s localhost:3000/api/health` | 迁移条数与漂移 | 即时 |
| 5 全页扫 | 见下 | 500 页、**水合失败** | ~3min |
| 6 全 API 扫 | 见下 | 500/错误码、缺参该 400 却 500 | ~3min |

`tsc` 输出要过滤 `.next/types`（Next 生成的噪声）：

```bash
npx tsc --noEmit 2>&1 | /usr/bin/grep -v "\.next/types"
```

---

## 登录（脚本与手工排查都要）

**provider id 是 `local`，不是 `credentials`。** 走错端点会拿到
`error=Configuration`，看起来像登录坏了——那是你的测试错，不是系统错。

```bash
rm -f /tmp/j.jar
CSRF=$(curl -s -c /tmp/j.jar http://localhost:3000/api/auth/csrf \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrfToken"])')
curl -s -b /tmp/j.jar -c /tmp/j.jar -o /dev/null -w "%{http_code}\n" \
  -X POST "http://localhost:3000/api/auth/callback/local" \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "username=admin" --data-urlencode "password=admin123"
curl -s -b /tmp/j.jar http://localhost:3000/api/auth/session
```

角色账号：`admin` / `ops01` / `purchasing01` / `warehouse01` / `pmc01` / `finance01`，
同一密码（`scripts/smoke-e2e.ts` 的 `PASSWORD`）。**验证脱敏必须换角色登录**——
用 admin 看不出 R9 有没有生效。

---

## 全页扫描（抓到过 24 页整页水合失败）

```bash
find "src/app/(app)" -name page.tsx | sed 's|src/app/(app)||; s|/page.tsx||' \
  | sed 's|^$|/|' | sort > /tmp/routes.txt

while read -r p; do
  code=$(curl -s -m 120 -b /tmp/j.jar -o /tmp/pg.html -w "%{http_code}" "http://localhost:3000$p")
  containers=$(/usr/bin/grep -o "ant-table-container" /tmp/pg.html | wc -l | tr -d ' ')
  theads=$(/usr/bin/grep -o "ant-table-thead" /tmp/pg.html | wc -l | tr -d ' ')
  [ "$code" != "200" ] && echo "  $code $p"
  [ "$theads" -gt "$containers" ] && echo "  水合疑似 $p (thead=$theads > 容器=$containers)"
done < /tmp/routes.txt
```

**判读**：`thead 数 > 表格容器数` 才是水合失败指纹。
一页有两张表 → 2 容器 2 thead，**正常**。只数 thead 会误报。

`[id]` 动态路由会被这个扫描漏掉——要用真实单号单独测：

```bash
curl -s -b /tmp/j.jar -o /dev/null -w "%{http_code}\n" \
  "http://localhost:3000/outsource/po/2/print"
```

---

## 全 API 扫描

```bash
find src/app/api -name route.ts | sed 's|src/app||; s|/route.ts||' | sort | while read -r r; do
  case "$r" in *"["*) continue;; esac   # 跳过动态段
  code=$(curl -s -m 120 -b /tmp/j.jar -o /tmp/api.json -w "%{http_code}" "http://localhost:3000$r")
  [ "$code" = "500" ] && echo "  500 $r :: $(head -c 160 /tmp/api.json)"
  [ "$code" = "400" ] && echo "  400 $r（确认是缺参校验而非真错）"
done
```

**400 是好的**（缺必填参数的正确响应）。**500 永远是 bug**——
哪怕根因是用户少传了参数：缺参必须 `throw new ApiError(400, "...")`，
用裸 `Error` 会被兜底成「系统错误，请联系管理员（错误码 xxx）」并污染 `error_logs`。

---

## 数据库直查（dev 库）

**PGlite 单进程**：脚本要访问 `.data/dev` 必须先停 dev server，否则报锁错。

```bash
pkill -f "next dev"; pkill -f next-server; sleep 4
npx tsx scripts/db-peek.ts
```

临时探查脚本写在 `scripts/` 下（`../src/db` 相对导入才解析得了别名），
**用完删掉**，别留在仓库里。

---

## 迁移后必做

新增迁移后 **必须重启 dev server**——PGlite 只在启动时应用迁移，
热更新的代码引用新列会全线 500。`/api/health` 会暴露漂移：

```json
{"ok":true,"migrationFiles":18,"applied":18,"drift":false}
```

---

## 并发会话

这个仓库常有**另一个会话同时在写**。提交前：

```bash
git log --oneline -5     # 有没有别人的新提交
git status --short       # 我的改动是否与之重叠
```

不重叠就正常提交。中文提交信息含括号会破坏 shell 引号——用文件：

```bash
git commit -F /tmp/commitmsg.txt
```

---

## grep 陷阱

本环境的 `grep` 被包装过会注入 `-G`，且仓库全是中文内容。**一律用 `/usr/bin/grep`**，
必要时加 `LC_ALL=C`。`--include=*.ts` 在 zsh 下会被当成 glob 报 "no matches found"——
要么加引号，要么改用 `find | xargs`。

---

## 验证的元教训

这个项目里**最贵的两个 bug 都不是靠读代码找到的，是靠系统性扫描找到的**：

1. **24 页整页水合失败**——`useListState` 用了 `useSearchParams`，`page.tsx` 缺 `<Suspense>`，
   `useId` 序列 SSR/CSR 错位，整页退化成无交互静态 HTML。页面照样返回 200，
   单测全绿。只有扫全部页面 + 看 DOM 指纹才暴露。
2. **客户端组件值导入服务端模块**——一个标签常量把 auth/pg/argon2 拖进客户端包，
   webpack 解析原生模块失败后污染模块图，**全应用含 `/api/health` 齐刷刷 500**，
   且现象随编译顺序漂移。

两个都是**既有缺陷**，都精确对应用户那句「系统看起来毛糙、有些功能像没做完」。

**结论：定期跑全量扫描，不要只测你改过的地方。**
