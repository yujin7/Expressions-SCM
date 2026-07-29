# 外部系统集成契约：聚水潭、用友、飞书

更新日期：2026-07-30
当前实现锚点：`main` 上的连接器代码、`docs/NOW.md` 与 `docs/spec/CURRENT.md`

## 1. 系统边界与唯一权威

| 事实域 | 权威系统 | SCM 的角色 | 当前接入状态 |
|---|---|---|---|
| 电商订单、实际出库销量、平台/WMS 库存观察 | 聚水潭 | 拉取、留证、映射、staging、与 SCM 自有仓出库对账 | 出库日事实与跨仓库存增量观察代码就绪；待真实 app/token/IP/权限 |
| SCM 委外单据、实时仓库存账、批次、质量、计划与审批 | 本 SCM | 业务与库存账权威 | 已运行；外部系统不得直接覆写 |
| 财务凭证、成本、结算与组织核算口径 | 用友 | 读取财务权威、提交获批业务结果、双向对账 | 仅契约；待企业 OpenAPI 应用与接口清单 |
| 协同触达 | 飞书 | 接收 SCM outbox 消息；不成为业务状态权威 | webhook 与应用机器人代码就绪；待任选一路配置 |

截至 2026-07-30 的实证结论：代码、契约与治理边界已就绪，但三方均未完成生产机器凭据握手，
因此任何面板都不得把「代码存在」或「人能登录」显示成 live/operational。

任何外部事实都走：

`received → parsed → validated → staged → reconciled → released / rejected`

连接器永不直接写 `stock_balances`、`stock_ledger`、成本、结算或正式销量表。库存仍只能
由 posting registry 过账；快照/销量仍沿用现有放行与人工裁决。

## 2. 聚水潭

### 官方契约

- [接入准备](https://openweb.jushuitan.com/doc?docId=20)：应用需 `app_key`、
  `app_secret`、`access_token`，并完成 IP 白名单和 API 权限；token 有有效期。
- [调用规范](https://openweb.jushuitan.com/doc?docId=30)：POST、
  `application/x-www-form-urlencoded;charset=UTF-8`，系统参数与 `biz` 都在 body；
  时间戳为秒且容许窗口有限；每商家受并发与分钟限流。
- [签名规则](https://openweb.jushuitan.com/doc?docId=70)：去掉 `sign`/空值，
  key 升序，拼接 `key+value`，前缀 `app_secret`，UTF-8 MD5 小写。
- [销售出库查询](https://openweb.jushuitan.com/dev-doc?docType=8&docId=34)使用
  `/open/orders/out/simple/query`；`start_ts` 必须按返回最大 `ts` 推进，`page_index`
  固定 1，页面不超过 50，并持续请求到没有更大 `ts` 的行。扫描过程中同一 `io_id`
  再次变化时保留最大 `ts` 的版本，不能让早到旧版本覆盖最终状态。
- [商品库存查询](https://openweb.jushuitan.com/dev-doc?docType=3&docId=15)使用
  `/open/inventory/query`，页面不超过 100。`sku_ids` 与修改时间不能同时为空；使用
  `ts` 时不传修改时间，时间窗口与 `ts` 两种模式互斥。未传 `wms_co_id`（或传 0）返回
  全仓总量，且官方响应字段不保证返回仓库编码。游标模式按最大返回 `ts` 继续请求；即使
  `has_next=false` 也不能据此把未返回 SKU 宣布为 0 或把结果冒充仓库粒度完整快照。
- [仓库查询](https://openweb.jushuitan.com/dev-doc?docType=1&docId=3)使用
  `/open/wms/partner/query`，仅返回启用仓库；客户端按 `has_next` 翻页、去重并排序，
  供后续仓库别名覆盖核验使用。

### 已实现

- `JstClient`：表单 POST、签名、15 秒超时、HTTP 退避、业务错误、结构校验。
- 日出库按 `io_date` 拉完整自然日；使用最大 `ts` 前进且拒绝不前进游标，达到安全页上限
  直接失败，绝不返回静默截断的「完整」结果。
- 只把 `Confirmed` / `Archive` 计入实际出库；取消、删除、待确认仍保留在源信封，
  不伪造成销量。
- 订单证据只保留 SCM 需要的单号、状态、时间、仓库、SKU、数量和批次字段，不落消费者 PII；
  如 ERP 开启生产批次管理，独立 `batchs` 节点按 `ioi_id` 保留批次号、数量、生产日和效期，
  为后续批次谱系对账留证，但未放行前不写库存账。
- 库存客户端强制 `ts` / 修改时间二选一，修改时间窗口不超过 7 天；同一 SKU×仓扫描内多次
  变化只保留最大 `ts` 的版本。库存数量、订单/拣货/库存锁定、在途/退货/次品、上下限等
  官方字段按十进制字符串校验，避免浮点改写。
- 新增显式 opt-in 的跨仓库存总量增量流：最大 `ts` checkpoint → 最小化证据 →
  `jst_inventory_observation` staging → SKU alias/未知值认领。它只表示
  `changed-since-cursor`，缺失行保持未知，绝不写 `stock_snapshots`、库存台账或把缺失补 0。
- 仓库目录客户端已实现，但在真实权限、仓库覆盖和仓别名验收前不自动改变 SCM 仓库主数据。
- 证据文件存于 `FILE_STORAGE_DIR/integration-evidence/jst/...`，内容寻址、SHA-256、
  0600 权限，并由 `integration_runs` 关联。
- SKU/仓库走通用 alias；未知值进入人工认领，绝不猜。
- 相同源信封重放返回原结果；失败不推进 `integration_checkpoints`。
- 每日 07:30 拉 T-1，08:00 再对账。缺配置记录 `skipped`；缺源覆盖时对账停止，
  不把未知当成 0。

### 运行配置

```text
JST_APP_KEY
JST_APP_SECRET
JST_ACCESS_TOKEN
JST_SYNC_ACTOR_ID
JST_BASE_URL（可选）
JST_INVENTORY_SYNC_ENABLED（可选，默认 false）
JST_LIVE_VERIFIED_AT（真实 UAT 通过后的 ISO-8601 时间）
```

`JST_SYNC_ACTOR_ID` 必须指向 SCM 内启用的责任人/服务账号。生产启用前还要完成：

1. 在聚水潭开放平台确认应用类型、商家授权、出库/库存接口权限和生产 IP 白名单。
2. 建立 access/refresh token 轮换责任人；当前代码不会用过期 token 猜测刷新流程。
3. 确认 ERP 与分仓是否开启生产批次管理；若开启，验证 `batchs.ioi_id` 能与商品明细关联，
   并核对批次数量合计、空批号和效期字段覆盖。
4. 用一日真实导出与 API 结果逐 SKU 对照：订单数、明细数、数量、取消/归档、仓库覆盖、
   未解析别名和最大游标。
5. 库存先以只读观察流接 staging/snapshot；在完整性、仓映射和控制总量验收前不得写实时账。
6. 连续运行至少 7 天，验证迟到修改、重复调度、限流、网络失败和恢复重放。

手工触发：

```bash
npx tsx src/jobs/cli.ts sync-jst 2026-07-28
npx tsx src/jobs/cli.ts sync-jst-inventory
npx tsx src/jobs/cli.ts reconcile-jst 2026-07-28
```

## 3. 飞书

### 两条可运行路径

1. 应用机器人（推荐）：`FEISHU_APP_ID` + `FEISHU_APP_SECRET` + `FEISHU_CHAT_ID`
2. 自定义机器人回退：`FEISHU_WEBHOOK_URL`

应用模式按飞书官方
[tenant_access_token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)
和[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)实现：

- token 按过期时间缓存并提前 60 秒刷新；
- `receive_id_type=chat_id`，每条 outbox 使用稳定 UUID 去重；
- UUID 最长 50 字符，飞书在 1 小时内对相同 UUID 至多成功发送一次；
- 应用发送失败且 webhook 已配置时自动回退；
- webhook 同时校验 HTTP 与飞书业务码；HTTP 200 但业务码非 0 仍保留为 failed 并重试；
- 多实例分发先以数据库条件更新原子认领 `sending` 租约；同一 outbox 行只有一个 worker
  能发送，进程中断遗留的租约 10 分钟后可恢复；
- SCM `notifications` 仍是 pending/sent/failed 的权威，飞书不改变审批或单据状态。

启用前需在开放平台开启机器人能力、至少授予 `im:message:send_as_bot`（或官方列出的等价
消息权限）、发布应用，并把机器人加入目标群且允许发言。飞书对同一群的机器人共享限频为
5 QPS；SCM outbox 保持串行投递，不以并发冲击群限流。

真实测试群完成投递、去重与失败恢复 UAT 后，才设置 `FEISHU_LIVE_VERIFIED_AT`。运维面板
只有在完整机器配置和该有效时间同时存在时才显示 Live UAT「已验证」；未来时间或非法时间
不会被接受。

## 4. 用友

[用友开放平台](https://developer.yonyou.com/openAPI)的官方流程是注册、创建应用、申请服务、
企业授权后调用；并支持 IP 白名单、分层限流和熔断。

提供的 C4 人工登录账号只能供人在管理界面操作，**不能**作为服务器 API 凭据，也未写入代码、
环境模板、日志或 Git。2026-07-29 已用该账号只读验证：

- 可以通过 SSO 进入 YonSuite/C4 业务租户与用友开放平台；
- 开放平台控制台实际进入 `#/unregister`，说明当前账号尚未注册开发者/ISV 身份；
- 因此目前不存在可供 SCM 使用的企业应用 client ID/secret、已申请服务或企业应用授权。

当前保持 `contract_only`，避免在未知产品版本/租户/组织/接口下伪接通。未自动注册开发者身份，
因为注册会接受平台条款、创建外部主体并可能要求企业/伙伴资料，属于必须由企业明确批准的外部变更。

所需机器配置：

```text
YY_CLIENT_ID
YY_CLIENT_SECRET
YY_TENANT_ID
YY_ORG_ID
YY_BASE_URL
YY_TOKEN_URL
```

按官方顺序，企业管理员/用友实施方还必须：

1. 批准并完成开放平台开发者/ISV 注册；
2. 创建企业应用，申请所需服务，由目标企业完成应用授权；
3. 确认实际产品与版本（YonBIP / YonSuite / C4 对应租户）；
4. 确认成本、凭证、采购/委外结算的具体 API 名称、版本、路径和字段精度；
5. 确认组织、账簿、币种、税、会计期间与供应商/SKU 映射；
6. 确认查询增量键、冲销/红字、更正、关账后调整和幂等外部单号；
7. 提供沙箱与生产 base/token URL、IP 白名单、限流、回调验签和错误码；
8. 把机器凭据放入部署密钥库，而不是聊天、文档或仓库；
9. 先只读对账，再启用提交；所有提交必须 maker-checker、同事务 outbox 和可逆补偿。

## 5. 观测、告警与验收

运维面板把「代码就绪」「机器凭据已配」「真实 Live UAT 已验证」分开显示；凭据存在不再
自动等于 operational。面板还显示能力、缺失环境变量、验证时间和阻塞说明。
运行与证据由以下事实证明：

- `integration_runs`：请求范围、源/落 staging/拒收行数、证据 hash/path、状态、错误；
- `integration_checkpoints`：最后成功游标、版本、时间和运行；
- `import_jobs` / `staging_rows`：来源日期、schema 版本、full/delta 范围、别名与拒收；
- `job_runs`：调度是否真正执行；
- `notifications`：飞书或站内投递状态。

上线门：

- 聚水潭真实握手、控制总量和 7 天恢复演练通过；
- 飞书测试群收到去重消息，应用失败时 webhook 回退被验证；
- 用友只读沙箱完成前不得标记 operational，更不得写财务事实；
- 密钥只存在部署密钥库/环境变量，轮换后旧值失效，日志与导出无 secret。
