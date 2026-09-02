# scripts/ 说明

目录里有两类脚本，按「是否被 package.json / 文档 / 代码引用」区分。**新增脚本请归到对应类别并在本文登记**。

## 一、现行入口（被 `package.json` 或文档引用）

| 用途 | 脚本 | 入口 |
|---|---|---|
| 门禁 | `verify-fast.ts` `verify-release.ts` `verify-ops.ts` `verify-postgres*.ts` | `npm run check:*` |
| 局域网/公网访问 | `install-public-tunnel.sh` `public-tunnel-daemon.sh` `remove-public-tunnel.sh` `show-access-link.sh` `sync-lan-auth-url.sh` `*mdns-alias.sh` `setup-public-tunnel.sh`（具名隧道，需域名）`setup-tailscale-access.sh`（需注册） | `npm run access:*` / `lan:*`；见 `docs/guides/对外访问方案-选型与步骤.md` |
| 账号 | `set-initial-passwords.ts`（逐人独立初始口令、首登改密）`reset-admin-emergency.ts`（三重开关）`reset-local-admin.ts`（仅 PGlite） | `docs/engineering/本机实跑指南.md` |
| 主数据纠正（逐条审计） | `recode-sku.ts`（零历史坏码改码）`fill-blank-sku-name.ts`（只补空名）`backfill-sku-names-from-transit.ts`（名称=编码时按源表品名回填） | 同上 |
| 简道云 | `jiandaoyun-survey.ts`（297 表单时效普查）`jiandaoyun-barcode-gap.ts` | `npm run jdy:*` |
| 冒烟 | `smoke-e2e.ts`（只读；`SMOKE_PASSWORD_<用户名>`）`perf-smoke.ts` | `npm run check:release` |
| 其它 | `dev-session.ts` `sanitize-standalone.ts` `normalize-next-env.ts` `patch-minimatch-brace-api.mjs` `make-square-icon.mjs`（由宽幅 logo 生成正方形标签页图标） | 构建/开发链 |

## 二、历史一次性脚本（2026-07/08 首批数据入库时使用，已被 staging→release 导入管道取代）

保留原因：它们是当时入库方式的证据，且仍可在**停掉 dev server** 后重跑核对；不再作为日常操作指引。
不要从这里复制逻辑到新代码——导入一律走 `src/server/import/*` 与放行引擎。

| 脚本 | 当时用途 | 最后改动 |
|---|---|---|
| `load-transit.ts` | 在途进度表全量入库（staging → 在途参考放行 + 起订量放行） | 2026-07-24 |
| `load-demand.ts` | 需求达成表入库 | 2026-07-24 |
| `load-pallet.ts` | 货盘表入库 | 2026-07-24 |
| `load-npd-stock.ts` | NPD 三件套 + 总库存汇总入库与核对 | 2026-08-10 |
| `release-sku-params.ts` | sku_leadtime staging → sku_params | 2026-07-24 |
| `claim-brands.ts` | 品牌别名认领 | 2026-07-24 |
| `peek-fee-blocks.ts` | 费用行放行阻塞探查 | 2026-07-24 |
| `verify-three-files.ts` | 三文件入库核验（hash×行数×重复×消费方） | 2026-07-27 |

> 判断口径：`grep -rl <文件名> package.json ops docs .claude src tests` 为空即视为"未被引用"。
> 若某脚本连续两次审计都未被引用且无重跑价值，直接删除（git 历史保留），不要再堆到 archive。
