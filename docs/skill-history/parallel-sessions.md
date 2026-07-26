---
name: parallel-sessions
description: Protect shared Git, dev-server, PGlite, test, and commit state when multiple agent sessions work in this repository. Use before staging, committing, stashing, starting or stopping servers, opening .data/dev, quoting test counts, or whenever files or results change unexpectedly. Do not use for genuinely solo read-only work.
---

> **ARCHIVE ONLY** — Historical evidence, not executable guidance. Do not run commands or follow
> routing in this file; use [the quarantine index](README.md) and current `.claude/skills/`.

# 假设另一个会话正在写

> 下文时间、PID、端口、提交、文件数与测试数是 2026-07-25 的事故证据，不是当前状态。
> Durable rule 是：每次外部状态改变后重新取证、逐路径归属、只控制自己的进程与文件。

17:45，`git status` 说「nothing to commit, working tree clean」。17:54，同一个仓库
`git status --short -uall` 列出 13 个未跟踪文件——`scripts/_tmp-alert-audit.ts` 到
`_tmp-round.ts`，mtime 从 17:49:25 密集排到 17:54:17，一个都不是我写的。
`git check-ignore -v scripts/_tmp-counts.ts` 无输出（**没被忽略**），`git add -A --dry-run`
逐行确认：这 13 个别人做到一半的调试脚本会全部进我的提交。

**一次 `git status` 的保质期，在这里是四分钟。**

---

## 提交：逐路径 add，并留下指纹

只有用户明确要求提交时才执行 staging/commit；否则保留 scoped diff 并报告。

```bash
git log --oneline -5          # 别人落了什么（已成文：supply-chain/SKILL.md:157）
git status --short -uall      # 未跟踪也要看，别人的临时脚本不在 .gitignore 里
git add src/... tests/...     # 逐个路径。git add -A / git add . 在这个仓库是错的
git commit -F /tmp/msg.txt    # 中文提交信息含括号会破坏 shell 引号
```

**git 身份完全无法区分两个会话**：14 个提交的 author 与 committer 全是同一个
`Yu Jin Chew <yujin7@gmail.com>`（`git log -14 --format='%an <%ae>' | sort | uniq -c` → `14 Yu Jin Chew`）。
事后唯一能分线的信号是提交尾注——5 个带 `Co-Authored-By: Claude Opus 5`、9 个不带，
且这个划分与两条业务主线逐条吻合。**那是巧合，不是机制。**
所以每个提交都必须主动带固定尾注或主题前缀；不带，事后没有任何办法归属。
交错最密处：`40db17b`（16:59:24）与 `7483c51`（16:59:46）**相隔 22 秒**。

**`git stash` 不带名字就是赌博**：stash 是全局共享、无命名空间的栈，这里已经掉过一次。
`git fsck --dangling` 报出 `5da3366`，形状是标准 stash（双 parent +「WIP on main: 10a9919 RT5 基座…」），
`git show --stat` = **23 个文件 / 1092 insertions**（含 auth/config.ts、release/engine.ts、report/export.ts）。
而 `git stash list` **是空的**——已被 drop，内容只是碰巧还没被 gc。

---

## 判定表

| 你看到的 | 真实含义 | 该做什么 |
|---|---|---|
| 冒出你没建的文件 | 另一个会话正在写 | 逐路径 add；**不删、不提交、不 stash** |
| 上次 `git status` 是几分钟前跑的 | 已过期 | commit 前重跑，禁止复用旧结论 |
| 测试数比上次多几十 | 别人提交了新用例 | 先 `git log --oneline -5` 再归因 |
| typecheck 结果变了但你没改 | 共享 incremental 缓存 | 删 `tsconfig.tsbuildinfo` 重跑 |
| curl 端口返回陌生状态 | autoPort 把你挪走了 | 先确认 PID+端口是哪台 |
| 目标文件 30 分钟前刚被重写 | 别人在改同一算法 | 先读那个提交正文的约束 |

最后一行是真事：`src/server/core/dedupe.ts` 由 `5149e3b`（13:54:47）创建，31 分钟后被 `480aed6`
（14:25:36）重写，`git diff --stat` = **216 insertions / 69 deletions**，正文写着「算法在 5,376 个真实
SKU 上被打脸三次，逐条修正」并留下反向约束「**不要改回单连接**」。不读就动手 = 把别人三轮修正推回去。
`.claude/skills/supply-chain/reference/excellence.md` 在 45 分钟内被 3 个提交各改一次
（16:59 / 17:06 / 17:27）——若用户已授权提交，共享文件应隔离并尽快提交；未授权时不要
擅自 commit，只报告 scoped diff，避免与其他工作混装。

---

## 共享的不止 git

### PGlite 数据目录：不会锁死报错，会静默分叉并丢数据

历史版本的 file-release 与 supply-chain 指南曾写「PGlite 单进程」，**这个措辞不够准确**。
现场：PID 30961（127.0.0.1:3001，1:55PM 起）与 PID 42081（127.0.0.1:3000，2:39PM 起）
各有 46 个 fd 开在同一个 `.data/dev`，分别持有不同 WAL 段（…008C / …008D），
两边 `/api/health` 都是 200 且完全一致（`migrationFiles:18, applied:18, drift:false`）。**无一方报错。**

隔离复现（两个 node 进程并发开同一 datadir 各写一行）：两边都 `OPENED OK in 127ms`；
随后 A 只看得见 SEED+A、B 只看得见 SEED+B（`total=2` 而非 3）；4 秒后 B `FAILED: Aborted()`；
重开目录 `SURVIVORS: [SEED, A]`——**B 那行已提交的数据永久消失**。
根因可见：`.data/dev/postmaster.pid` 第 1 行是 `-42`（假 PID），Postgres 的 datadir 互斥锁永不触发。

脚本直连 `.data/dev` 前先数写者。正在发生的窗口：另一个会话的 `scripts/_tmp-alert-audit8.ts:1`
以 `process.env.DATABASE_URL ??= "pglite:.data/dev"` 开头再 `getDbAsync()`，
往已被两台 dev server 持有的目录上叠第三个写者。

### 停服务：禁止全机 pkill

历史 file-release 指南里的全机模式匹配终止命令会杀掉其他会话的 dev server。
按端口定位、按 PID 精确停：

```bash
lsof -nP -iTCP -sTCP:LISTEN | /usr/bin/grep 300   # 有几台、各是谁
kill <自己那台的 PID>                              # 只杀自己启的
```

### 端口：你 curl 的可能是别人的服务器

`.claude/launch.json:12` 是 `"autoPort": true`——3000 被占就**静默挪到 3001**，
而 `.env:3` 写死 `AUTH_URL=http://localhost:3000`。于是你按文档 curl 3000，
打到的是另一个会话的服务器，它的代码状态和你的不一样。验证前先钉死 PID+端口，别只看 200。

### incremental 缓存共享

`tsconfig.tsbuildinfo`（741,279 字节）被 `.gitignore:5` 排除，不入库也就没有冲突提示，两个会话共用一份：
`npm run typecheck` 的结果取决于**谁上一个跑过**。`480aed6` 正文点名过它——
`tests/report/data-health-structural.test.ts` 的 skuType 类型错误「incremental tsc 缓存此前一直掩盖着它」。

---

## 测试数字：先归因，再报

可复现的真实序列：**628 → 713 → 730 → 744 → 751**。628 由 `b8bc267`(13:44:57) 静态 645 按本仓库稳定的
「静态数−17 = runtime passed」映射得出；713/730/744 写在 `5149e3b`/`480aed6`/`7483c51` 的提交正文里，
**全部来自另一个会话**；751 是本轮实跑（HEAD=311004f）`Tests 751 passed | 21 skipped (772)` / 14.22s。
其中 **628→713 是 10 分钟内 +85**，全由一个提交贡献。

- 数字涨了**不等于你干的**。跑完先看 `git log --oneline -5` 再写结论。
- 提交之间的中途跑（工作区混着别人未提交的文件）**谁也复现不出来**，别引用这种数。
- 随机 FAIL 先怀疑并发：`vitest.config.ts:8-11` 已写明单会话内 18 核并行就能饿死
  `createTestDb()`（故 `hookTimeout: 30000`）。另一台 dev server 或另一个 vitest 同时在跑时概率更高——
  单跑通过只能说明失败尚未稳定复现，既不能证明产品缺陷，也不能排除竞态；记录环境并重复、
  隔离、缩小边界后再分类。

---

## 报告口径

- 说「我改完了 X」之前先 `git log --oneline -5`：X 若已被别人改过，你的描述就是错的。
- 报测试数带 HEAD（`751 @ 311004f`）。不带 HEAD 的数字对读者无意义。
- `.claude/launch.json` 与 `.claude/settings.local.json` 仍被 `.gitignore` 挡住（`git check-ignore` 确认）——
  每个会话的本地配置互不可见，别假设对方看得到你的端口或权限设置。
- 改了 skill 就动态核对 canonical 与 discovery 层：
  `find .claude/skills -mindepth 1 -maxdepth 1 -type d`、
  `find .agents/skills -mindepth 1 -maxdepth 1 -type l`，并在获授权提交前用
  `git status --short -uall` 确认这些路径会入库。`.gitignore` 的
  `.claude/*` + `!.claude/skills/` 是事故修复产物：`01bf0a7`(14:34:42) 宣称新增 5 个 skill，
  `git show --stat` 实际只有 `CLAUDE.md`（1 file changed），55 秒后 `c8680fa` 才真正入库。
  **不入库的 skill 等于没有——其他会话只加载仓库里的。**
