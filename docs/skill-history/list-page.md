---
name: list-page
description: Build or modify list pages and client components in this project using required Suspense, useListState, ListToolbar, paramPrefix, client/server import, search, and empty-state conventions. Use for new app pages, tables, filters, tabs, or any use-client file. Use release-sweep for after-the-fact whole-app verification.
---

# 页面返回 200，不等于页面活着

这个项目最贵的两个缺陷，都返回 HTTP 200，都单元测试全绿，都「看起来做完了」。一次是 **24 个页面整页水合失败**——`page.tsx` 少包一层 `<Suspense>`，页面退化成无交互的静态 HTML：Tab 变成纯文本列表、表头重复出现、点什么都不动（commit aaf3d63，24 个 `page.tsx` 一次性补边界）。另一次是一个 `"use client"` 文件为了取一个标签常量**值导入**了 `@/server/*`，把 auth/pg/argon2 拖进客户端包，webpack 解析原生模块失败后污染模块图，**全应用连同 `/api/health` 齐刷刷 500，68 页里 23 页连锁失败**，且随编译顺序漂移。两条都不是读代码读出来的，是扫出来的。这份纪律是让它们不必再被扫一次。

## 列表状态只有一个平台，不要新写

`src/components/useListState.ts` + `src/components/ListToolbar.tsx` 是唯一实现：36 个 `-client.tsx` 共 41 个实例，34 个文件用 `<ListToolbar>`，0 个重复 localStorage key，手搓 `useState(1)` 分页剩余 **0 处**。

- config：`{ key, defaults, paginated?=true, defaultPageSize?=50, paramPrefix? }`（`useListState.ts:38-53`）
- 返回：`filters/setFilter/resetFilters/page/pageSize/setPage/density/setDensity/tableSize/shareUrl/savedViews/saveView/applyView/deleteView/queryString`（`:55-75`）
- `ListToolbar` 只有 4 个 prop：`{ state, extra?, onExport?, exportText?="导出 CSV" }`（`ListToolbar.tsx:15-23`）——自定义筛选控件全部塞 `extra`

两个抄代码时会静默读到旧值的地方：`defaultsRef = useRef(cfg.defaults)` 只在首渲染取值（`:240`），`defaults` 依赖 props/state 变化会被无声忽略；`queryString` 的 useCallback 依赖数组是**空的**（`:367-372`），靠 `parsedRef` 逃逸闭包——照抄这个模式而忘了同步 ref，就会拿着上一次的筛选去 fetch。

## 一、page.tsx 先包 `<Suspense>`，再写页面

范式是 `src/app/(app)/report/risk/page.tsx`，全文 9 行：

```tsx
import { Suspense } from "react";
import RiskClient from "./risk-client";
export const metadata = { title: "风险库存处置" };
export default function Page() {
  return <Suspense><RiskClient /></Suspense>;   // useSearchParams 需要边界
}
```

全仓 **0 处**写 `fallback=`——不要自作主张加骨架屏。触发条件是 `useListState` 内部用了 `useSearchParams`（`useListState.ts:16` 导入、`:233` 调用），所以「这页没直接写 useSearchParams」不构成豁免，传递依赖照样中招。「useId 序列 SSR/CSR 不一致」是项目自己在 aaf3d63 与 CLAUDE.md 里记录的诊断，未独立复现；**能复现的是症状与修法**：表头重复 / Tab 变纯文本 / 点不动，加边界即消失（判定指纹见 `release-sweep`：`thead 计数 > 表格容器计数` 才算数）。

现状：对 75 个 `page.tsx` 做过 import 传递闭包扫描，缺边界的 = **0**，36 个 useListState 页 100% 已包。**这条现在是防复发，不是补欠债**——新建页面时漏掉，就是把 24 页事故重开一次。

## 二、`"use client"` 文件的 import 是爆炸半径最大的一行

跟着值导入走全图（97 个 `"use client"` 文件）：共 44 条链条通往 `server/`、`db/`、`jobs/`，**44 条终点全部是白名单里的 `@/server/core/constants`**，最长 4 跳（`spu-client → spu-regroup-drawer → labels.ts → constants.ts`）。所以纪律不是「客户端不许碰 server 目录」，而是 **「客户端只能碰零依赖纯常量」**，链条深了肉眼根本看不出来。正确修法可查证：当年的肇事文件 `src/app/(app)/report/exports/exports-client.tsx:12` 现在只 `import type { ExportJobRow } from "@/jobs/export-worker"`，标签改由 API 下发（`src/app/api/export/jobs/route.ts:41` `kindLabel: EXPORT_KIND_LABELS[r.kind]`）。

护栏 `tests/architecture/client-server-boundary.test.ts` 当前全绿，但有两处盲区：

| 护栏管不到的 | 证据 | 会错成什么样 |
|---|---|---|
| 没有 `"use client"` 指令、却被打进客户端包的共享模块 | 测试 `:39` `if (!/^\s*["']use client["']/m.test(src)) continue;`；`src/components/labels.ts:3` 已值导入 `@/server/core/constants`，被 16+ 个 client 组件引用 | 往 `labels.ts` 加一句 `@/server/auth` → 500 事故原样复现，而 `npx vitest run tests/architecture` 全绿 |
| `@/jobs/*` 与 `@/db` 同样是服务端专属 | 测试 `:41` 正则只匹配 `@/server/…`；`src/jobs/export-worker.ts:9-11` 值导入 `@/db` + `@/db/schema` + `node:fs/promises` | 把 `exports-client.tsx:12` 那句 `import type` 写成值导入，就把 pg 拖进客户端包 |

要新增白名单条目，先满足 `:53` 的防腐化断言：该模块自身必须**零 import**。

## 三、同页多列表：`paramPrefix` 必填且互不相同

不填 = 单列表页。同页两个及以上独立列表（每 Tab 一份）不给前缀，Tab 之间会**互相清空 URL 参数**（`useListState.ts:47-52` 类型注释；机制在 `:113-114`：有前缀时以当前查询串为底，只增删自己的参数）。aaf3d63 当时主动放弃迁移 4 个多 Tab 页，ecaa623 补齐平台能力后才迁完，浏览器实测 `?fg_q=AAA&pkgo_q=BBB&fg_page=2` 三参数全部存活（测试 `tests/components/useListState.test.ts:201-235`）。两个未写进文档的行为，铺开时最容易踩：

1. 带前缀的实例**主动关闭** localStorage 自动恢复（`:268-279` 里 `if (cfg.paramPrefix) return;`，理由是整串恢复会抹掉兄弟实例）。所以单列表页有「回到离开时的现场」、多 Tab 页没有——**这是设计，别当 bug 报**。
2. **保存/应用视图会污染兄弟 Tab（现存缺陷）**：写路径四条只有三条走 base 合并——`setFilter(:343)`/`resetFilters(:349)`/`setPage(:355)` 都传 `base: baseRef.current`；而 `saveView(:316)` 存的是整串 `currentQuery`（含所有兄弟前缀），`applyView(:325)` 直接 `push(query)` 整串替换。后果：在 `/report/transit` 的「成品在途」Tab 存视图，会把当时「包材在途」的筛选一起腌进去，日后应用即覆写兄弟。现有测试只覆盖 `buildQueryString` 的 base 合并，**没有一条覆盖 saveView/applyView × 前缀**——动这块先补测。

## 四、搜索框有一条强制惯例（37 处里 31 处遵守）

```tsx
<Input.Search key={q} allowClear defaultValue={q}
  placeholder="搜索编码/名称" style={{ width: 240 }}
  onSearch={(v) => listState.setFilter({ q: v.trim() })} />
```

范式在 `src/app/(app)/report/risk/risk-client.tsx:233-239`。三个要点缺一不可：`key={q}` 强制重挂载，点「重置」或应用视图后输入框文字才跟着 URL 回同步；`defaultValue` 走非受控；用 `onSearch`（回车/点按钮）而不是 `onChange`，否则每敲一个字符 `router.replace` 一次。

两个反例正是仅有的两个「用了 useListState 却没用 ListToolbar」的页：`src/app/(app)/replenish/replenish-client.tsx:383` 与 `src/app/(app)/review/checklist/checklist-client.tsx:295`，两者 `key` 和 `defaultValue` 都没有——带 `?q=XXX` 深链进去，**表格已经过滤了而搜索框是空的**。照抄页面时别抄这两个。

## 五、空态：按业务意义判空，且 error 与 empty 必须分开

现存反面教材在工作台：`src/server/modules/workbench/focus.ts:357-363` 无条件返回**固定 5 条**队列，于是成功路径上 `queues.length === 0` 永远不成立——那条空态 Alert 是死代码；队列全 0 时页面显示 5 张灰色 0 卡片，一句「没有待办」都没有。而它唯一会触发的场景是 fetch 失败（`workbench-client.tsx:133` `.catch(e => message.error(…))`，`queues` 留在 `[]`），结果页面在一次**加载失败**上压一条绿色 success「当前没有待你处理的单据」（`:159-166`）。

- 判空按业务意义（所有计数为 0），不按数组长度：服务端返回定长骨架时，长度判空恒为假。
- `error` 态与 `empty` 态分开存：加载失败时显示「没有数据」，是在对用户撒谎。
- 兜底常量要么有内容要么别留：历史上 `PLACEHOLDER_QUEUES` 是**空数组**，`queues.length ? queues : PLACEHOLDER_QUEUES` 等于没兜底，页面静默塌缩成只剩一张卡，看起来像功能没做完（commit 518c10e 已删除，src 全仓已搜不到该标识符）。

## 六、antd 5.29.3：`destroyOnClose` → `destroyOnHidden`

弃用映射实证在 `node_modules/antd/es/modal/Modal.js:93` 与 `es/drawer/index.js` 的 deprecated 表（都列了 `['destroyOnClose','destroyOnHidden']`）。commit b8bc267 一次改了 **6 文件 7 处**；当前 `destroyOnClose` 0 处、`destroyOnHidden` 9 处 / 8 文件。理由不是「告警刷屏」——rc-util 的 `warningOnce` 按 message 去重、antd 还按 component 聚合，一个组件类型最多打 1 行；理由是弃用属性下一个大版本会**真的失效**（抽屉关闭后表单不重置，脏数据带进下一次打开），且控制台任何常驻噪音都在稀释信号。

## 提交前自检（两条扫描 + 一次测试）

```bash
# 1) Suspense 边界 —— 这条纪律至今零自动化护栏，只能手扫。期望：无输出
find "src/app/(app)" -name page.tsx | while read -r p; do
  d=$(dirname "$p")
  hit=$(/usr/bin/grep -rl -e useListState -e useSearchParams "$d" --include='*-client.tsx' 2>/dev/null)
  if [ -n "$hit" ] && ! /usr/bin/grep -q Suspense "$p"; then echo "缺边界 $p"; fi
done

# 2) 客户端边界（直接层；深链条交给 tests/architecture）。期望：只剩 @/server/core/constants 那一行
/usr/bin/grep -rln '"use client"' src --include='*.tsx' --include='*.ts' | while read -r f; do
  /usr/bin/grep -nE '^[[:space:]]*import[[:space:]]+[^;]*from[[:space:]]*"@/(jobs|db|server)' "$f" \
    | /usr/bin/grep -v 'import type' | sed "s|^|$f:|"
done

npx vitest run tests/architecture tests/components   # 2 files / 33 tests，~220ms
```

**最高杠杆的一件待办**：给 Suspense 补一个与 `tests/architecture/client-server-boundary.test.ts` 同构的架构测（`page.tsx` 的 import 传递闭包里出现 `useSearchParams` → 必须含 `Suspense`），75 页跑完 <1s。同一批「最贵的两个 bug」里，边界事故拿到了测试，水合事故至今只有 CLAUDE.md 的散文 + release-sweep 的人工扫描（`/usr/bin/grep -rn "Suspense" tests/` = **0 命中**）。

**报告口径**：说「页面做完了」之前，贴上面两条扫描的实际输出和 vitest 的实际数字。只说「本地看着正常」等于没验——24 页水合失败那次，浏览器里也「看着正常」，直到你去点它。
