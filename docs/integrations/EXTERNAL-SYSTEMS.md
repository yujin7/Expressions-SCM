# 外部系统集成契约：聚水潭、简道云、用友、飞书

更新日期：2026-08-03
当前实现锚点：`main` 上的连接器代码、`docs/NOW.md` 与 `docs/spec/CURRENT.md`

## 1. 系统边界与唯一权威

| 事实域 | 权威系统 | SCM 的角色 | 当前接入状态 |
|---|---|---|---|
| 电商订单、实际出库销量、平台/WMS 库存观察 | 聚水潭 | 拉取、留证、映射、staging、与 SCM 自有仓出库对账 | 出库日事实与跨仓库存增量观察代码就绪；待真实 app/token/IP/权限 |
| 现行低代码 ERP 表单与历史流程 | 简道云 | 全量目录、显式表单观察、字段最小化、留证与 staging；不直接成为 SCM 正式事实 | OpenAPI 已完成只读握手；目录与九条观察契约代码就绪，待密钥轮换、业务对账控制总量与 UAT |
| SCM 委外单据、实时仓库存账、批次、质量、计划与审批 | 本 SCM | 业务与库存账权威 | 已运行；外部系统不得直接覆写 |
| 财务凭证、成本、结算与组织核算口径 | 用友 | 读取财务权威、提交获批业务结果、双向对账 | 仅契约；待企业 OpenAPI 应用与接口清单 |
| 协同触达 | 飞书 | 接收 SCM outbox 消息；不成为业务状态权威 | 代码就绪；现有共享应用已上线但严重过度授权且看不到群，待最小权限隔离、目标群与 UAT |

截至 2026-08-03 的实证结论：简道云 OpenAPI 密钥已完成只读握手，九条契约的 API 技术
行/子表计数与 schema hash 再次稳定；飞书应用凭据可换取 tenant token，应用已启用并存在
在线机器人版本。但简道云尚未完成权威视图裁决、业务对账控制总量/业务方 UAT；飞书共享
应用拥有 1,107 项权限（其中 1,007 项为高级/超敏感）且仍看不到任何测试群；用友也缺少完整
企业授权上下文。因此任何面板都不得把「代码存在」「凭据可鉴权」或「人能登录」显示成
live/operational。

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
JST_LIVE_VERIFIED_REF（非秘密 UAT 证据编号，例如 UAT-20260730-JST-001）
```

`JST_BASE_URL` 只接受官方 `https://openapi.jushuitan.com`（可省略或带末尾 `/`）。
相似域名、HTTP、嵌入用户信息、查询串或其他路径会在签名和 access token 发送前被拒绝。

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
npx tsx src/jobs/cli.ts audit-connectors
npx tsx src/jobs/cli.ts sync-jst 2026-07-28
npx tsx src/jobs/cli.ts sync-jst-inventory
npx tsx src/jobs/cli.ts reconcile-jst 2026-07-28
```

`audit-connectors` 不打开数据库或调用外部 API，只输出代码状态、缺失环境变量名、UAT
状态和非秘密证据编号；对有显式开关/契约的连接器还分别输出启用状态、契约选择状态与数量。
它不会输出凭据、租户/组织值、端点或获批接口清单，可附在内部发布单。

## 3. 简道云

### 已验证的源事实

- OpenAPI 使用 HTTPS POST JSON，`Authorization: Bearer <API_KEY>`；应用、表单、字段与数据
  分页均以官方 v5 接口读取。
- 当前 API key 可见 9 个应用、297 个表单视图。相同 `entry_id` 会在多个应用中出现，
  且字段可见性与返回行数并不相同；因此表单名称和裸 `entry_id` 都不是全局唯一同步键。
- 新「供应中心」23 个表单中，20 个仍无可用字段/业务数据；真实在用记录主要位于
  「进销存管理」「仓库管理」「采购供应链」。系统不会因为目标应用看起来结构更现代就把
  空表误认作权威，也不会把重复应用视图相加。

### 已实现

- `JiandaoyunClient`：应用/表单/字段/数据分页、24 位对象 ID 校验、HTTPS 基址、15 秒超时、
  限次重试、游标不前进和 1,000 页安全上限。
- 数据查询使用 OpenAPI `fields` 只请求契约需要的顶层字段与
  `createTime/updateTime/deleteTime`；每行返回的 `appId/entryId` 必须与请求完全一致，
  防止授权视图或响应串表。简道云对子表投影仍会返回整个子表，因此未入契约的子字段只在
  进程内短暂存在，写 evidence/staging 前继续强制剔除。
- `catalog` 流只留存所有可见应用/表单的元数据，不读取业务行。
- 九条显式观察契约覆盖产品、采购需求、采购订单、采购入库、供应商、仓库、调拨、盘点和
  样品；只保留供应链决策所需字段，排除联系人、手机、地址、银行账号、税号、附件、图片及
  用户/部门对象。
- 每次表单同步先校验字段契约并计算 schema hash；字段缺失即停止，额外字段默认忽略，
  防止简道云改表后静默错列。
- 业务行按 `app_id + entry_id + data_id` 身份进入内容寻址 evidence 和现有
  `import_jobs/staging_rows`；相同信封重放不重复。导入任务、身份异常、staging、运行成功与
  checkpoint 在同一事务提交；失败整批回滚并保留可重试运行史，崩溃遗留的 running 租约
  超时后由新 attempt 接管，旧 attempt 受时间令牌隔离，不能迟到覆盖。
- OpenAPI 没有提供本项目可用的源快照 token，因此分页读取只声明
  `paginated-authorized-observation`，不冒充同一时点全量快照；重复 `data_id`、游标不前进或
  控制行数异常均停机。每条表单流的验收提交按数据库事务锁串行化；新观察不仅不得回退源时点
  或减少总行数，还必须包含上一有效批次的全部 `sourceRecordId`。当前没有可信删除墓碑，因此
  同数量换 ID、用新增行掩盖旧记录缺失或旧批次身份清单不完整都会失败，旧待复核批次与
  checkpoint 保持不变。目录 checkpoint 也采用相同的流锁与较新运行隔离。业务控制总量与
  第二次稳定读取仍是 UAT 必检项。CI 另在一次性 PostgreSQL 16 数据库里用两个独立连接证明
  advisory lock 会真实阻塞并串行提交，且最终 checkpoint、有效 import job 和 staging payload
  全部指向较新的源信封；测试数据随后删除，不接触开发/生产库。
- 所有行固定 `observation-only + releaseBlocked`，不会直接更新 SKU、供应商、仓库、价格、
  BOM、单据、库存余额或台账；空结果也只是“本授权视图为空”，不是业务事实为零。
- 连接器来源别名按 `JIANDAOYUN` scope 与企业通用/聚水潭/用友隔离；同一短码可在不同系统
  归属不同主档。人工认领 SKU 时会同事务写 scoped `sku_identifiers` 和审计；既有归属冲突
  会回滚，不会用全局别名静默抢占。
- MCP 仅保留为个人 AI 助手的人工查询渠道，不进入后台同步或生产写路径。

配置：

```text
JIANDAOYUN_API_KEY
JIANDAOYUN_SYNC_ACTOR_ID
JIANDAOYUN_SYNC_ENABLED（默认 false）
JIANDAOYUN_SYNC_CONTRACTS（逗号分隔的显式契约 key）
JIANDAOYUN_BASE_URL（可选）
JIANDAOYUN_LIVE_VERIFIED_AT（真实 UAT 后）
JIANDAOYUN_LIVE_VERIFIED_REF（非秘密 UAT 证据编号，末尾绑定当前契约集）
```

`JIANDAOYUN_BASE_URL` 只接受官方
`https://api.jiandaoyun.com/api/v5`（可省略或带末尾 `/`）。即使误配为另一个 HTTPS
域名，系统也会在发送 API key 前拒绝，避免机器凭据外泄。
凭据与责任人齐全只表示 `configured`；简道云只有在
`JIANDAOYUN_SYNC_ENABLED=true`、`JIANDAOYUN_SYNC_CONTRACTS` 至少选中一条已知契约，
带日期和非秘密证据编号的 Live UAT 仍有效，REF 等于或以 `audit-connectors` 输出的
`expectedLiveVerificationBinding`（`JDY1_...`）结尾，且 `JIANDAOYUN` 作用域待裁决身份异常为 0 时，
才能标记为 `operational`。
空契约、未知契约或无效开关值均显式拦截，不会因凭据存在而自动启用。
契约会按 key 去重、排序，并把 app/form、目标表、字段/子表映射、业务键、数值与对账规则一并
生成单向绑定；新增、移除或修改任一契约都会使旧 UAT 证据变为 `unbound`，必须按新范围重验，
避免扩大同步范围或改字段后沿用旧验收结论。

手工触发：

```bash
npx tsx src/jobs/cli.ts audit-jiandaoyun-contracts
npx tsx src/jobs/cli.ts sync-jiandaoyun-catalog
npx tsx src/jobs/cli.ts sync-jiandaoyun-forms
npx tsx src/jobs/cli.ts sync-jiandaoyun-form sample-management-observation
```

`audit-jiandaoyun-contracts` 不打开 SCM 数据库、不落源业务值，只输出九条契约的聚合控制量：
目录应用/表单数、重复 `entry_id`/名称组数、已选视图唯一性、主/子表行数、活跃/删除行、
字段非空覆盖、业务键缺失/重复、数量/金额定点汇总、表头对明细差异、新鲜度阻断、契约
schema hash 与源数据时间范围。数值总量用定点小数累加；删除行不参与业务键、数值和对账控制。
样品表当前没有可证明唯一的单号，因此不伪造业务键，仍以 `app_id + entry_id + data_id` 作观察身份。
数量/金额总量仍是机密经营数据：输出标记为 `internal-aggregate-business-controls-no-raw-rows`，
只能进入内部审计证据，不得复制到公开 CI 日志、issue 或外部沟通。

2026-08-02 以 schema envelope v3 重新实测：

- API key 仍可读取 9 个应用、297 个表单；
- 目录内有 17 组重复 `entry_id`、21 组重复表单名；9 条已选契约都能精确命中
  `app_id + entry_id`，但其中 7 条的 `entry_id` 和名称在目录中并不唯一，因此仍需业务责任人确认读取权威；
- 九条契约共 128 条主表记录、131 条子表记录；
- 活跃行 128、删除行 0；采购需求的 `requestNo + productCode` 有 2 组/4 行重复候选，
  需根据源单据版本或明细语义人工裁决，不自动去重；其他 7 条已声明业务键的契约在当前观察内完整且唯一；
- 采购订单表头/明细数量均为 3,533；表头订单金额 1,881,730.00，明细含税金额
  1,881,744.43，定点差异 -14.43；21 单逐单核对为 6 单一致、15 单差异，标记为 `mismatched`。
  采购入库的实收数量/金额、调拨数量、
  盘点盘亏/盘盈和样品数量的表头/明细对账一致；入库表头订货数仅 1/18 有值，故明确为
  `insufficient_coverage`（1 单一致、17 单证据不足），不把 -2,893 当成已证实差异；
- 128 条主表记录已逐条进入 128 条 `releaseBlocked` staging；九条契约精确重放全部复用原
  run/import job，未制造重复行；
- SKU 5,376、SPU 348、供应商 156、仓库 25、库存余额 344、库存流水 348、PO 3、WO 1，
  同步前后正式表计数不变；
- 最新一条源更新时间为 2024-12-11，距本次核验 599 天；其余契约更旧；
- 九条契约在宽松的 90 天现行使用筛查下全部为 `stale/currentUseBlocked`；
- 因此当前授权视图只能作为历史迁移/交叉核对源，不能被标记为 2026 年实时低代码 ERP 权威。

上线前必须：

1. 轮换曾通过聊天传递的 API key 与 MCP URL token；生产只用最小权限 OpenAPI key，并配置
   IP 白名单。MCP token 不用于服务器。
2. 业务负责人确认每个重复表单视图的唯一读取权威；同一 `entry_id` 不得跨应用累加。
3. 逐契约核对表单行数、子表行数、数量/金额、删除记录、更新时间与空值。
4. SKU、仓库、供应商和单号完成 crosswalk；歧义进入人工裁决，不按名称相似度自动合并。
5. 连续运行并验证限流、改表、删除、空表、重复调度、失败恢复与 evidence 重放。

## 4. 飞书

### 两条可运行路径

1. 应用机器人（推荐）：`FEISHU_APP_ID` + `FEISHU_APP_SECRET` + `FEISHU_CHAT_ID`
2. 自定义机器人独立路径：`FEISHU_WEBHOOK_URL`

自定义 webhook 必须是精确的
`https://open.feishu.cn/open-apis/bot/v2/hook/{token}`；非 HTTPS、相似域名、用户信息、
查询串或其他飞书 API 路径都会在发送业务摘要前被拒绝。

应用模式按飞书官方
[tenant_access_token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)
、[获取应用信息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v6/application/get)
和[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)实现：

- token 按过期时间缓存并提前 60 秒刷新；
- `receive_id_type=chat_id`，每条 outbox 使用稳定 UUID 去重；
- UUID 最长 50 字符，飞书在 1 小时内对相同 UUID 至多成功发送一次；
- 应用发送一旦发起便不自动跨渠道回退；网络超时可能已经送达，而 webhook 没有同一 UUID
  去重能力，自动回退会制造双发。应用未配置时才使用 webhook 路径；
- webhook 同时校验 HTTP 与飞书业务码；HTTP 200 但业务码非 0 仍保留为 failed 并重试；
- 多实例分发先以数据库条件更新原子认领 `sending` 租约；同一 outbox 行只有一个 worker
  能发送，进程中断遗留的租约 10 分钟后可恢复；
- SCM `notifications` 仍是 pending/sent/failed 的权威，飞书不改变审批或单据状态。

启用前需在开放平台开启机器人能力；只读发现需授予 `im:chat:readonly`（或官方等价群信息
权限），投递需至少授予 `im:message:send_as_bot`（或官方等价消息权限）。权限进入当前发布
版本后，把机器人加入同租户目标群并允许发言。飞书对同一群的机器人共享限频为 5 QPS；
SCM outbox 保持串行投递，不以并发冲击群限流。

2026-08-03 通过官方 `GET /open-apis/application/v6/applications/me` 进行只读复核：现有自建
应用处于启用状态、存在在线版本，桌面与移动默认能力均为机器人，且权限清单中
包含 `im:chat:readonly` 与 `im:message:send_as_bot`。功能投递仍阻塞在群可见性和真实投递，
但同时发现该共享应用拥有 1,107 项权限，其中 1,007 项为高级/超敏感权限。SCM 通知不应继承
如此宽的攻击面：优先创建专用 SCM 通知应用，只保留群发现、应用发消息和只读自检所需的
三项最小权限；若必须
复用共享应用，需由安全/应用责任人完成逐项权限裁决并留下非秘密证据。未裁决前不得标为
production-safe，也不得自动删权，以免破坏该共享应用的其他业务。

应用机器人和 webhook 必须分别完成真实测试群 UAT：应用路径写
`FEISHU_APP_LIVE_VERIFIED_AT/REF`，webhook 路径写
`FEISHU_WEBHOOK_LIVE_VERIFIED_AT/REF`。运行时只采用当前实际发送路径的证据；两条路径同时
配置时应用机器人优先，webhook 的 UAT 不能替代应用路径验收。旧的未绑定路径
`FEISHU_LIVE_VERIFIED_AT/REF` 不再接受，避免切换鉴权路径后沿用错误的验收证据。
应用路径还要求 `FEISHU_CHAT_ID` 与当前可见群精确匹配，且 REF 等于或以
`probe-feishu-chats` 输出的 `send.expectedEvidenceBinding` 结尾；该非秘密单向摘要把验收记录
绑定到当前应用和目标群，换应用、换群或沿用旧证据都会保持阻塞。
时间必须是带 `Z` 或明确时区偏移的 ISO/RFC3339 时间；
证据编号必须以字母或数字开头，整体只接受 3–80 位字母、数字、点、下划线或连字符；不写
URL、查询串、token 或密钥。
应用机器人还必须填写 `FEISHU_APP_PERMISSION_REVIEWED_AT` 与
`FEISHU_APP_PERMISSION_REVIEWED_REF`。后者等于或以 `probe-feishu-chats` 输出的
`permissionReview.expectedEvidenceBinding`（`FSP2_...`）结尾，把最小权限复核同时绑定到当前应用
和规范化后的权限名称+等级指纹；同一应用增删权限、变更权限等级、换应用或超过 90 天都会使旧证据
失效。只有当前权限清单已收敛到可接受范围后才能登记该证据；静态配置审计没有同次只读权限观察时
保持阻塞，标记本身也不能覆盖探针发现的 `extreme_over_privilege`、`review_required` 或 `unknown` 状态。
聚水潭与简道云使用同样的双字段契约。运维面板只有在完整机器配置、合法证据编号和 90 天内
的有效时间同时存在时才显示 Live UAT「有效」；未来、非法、过期或缺证据的标记都不算
operational。凭据、接口范围或权威视图发生实质变化时，必须重新验收并更新两项标记。

只读发现命令：

```bash
npx tsx src/jobs/cli.ts probe-feishu-chats
```

该命令只使用应用凭据读取本应用启用/在线版本/机器人默认能力和权限聚合，再列出机器人当前
可见群；不打开业务数据库、不返回应用身份或权限明细、不发送消息、不改变群成员。输出把
权限声明、群目录实际调用、可见群、路径绑定 UAT 和运行健康分开；权限未知或膨胀时宁可阻塞。
2026-08-03（上海时间；2026-08-02 17:03 UTC）再次实测鉴权成功，应用启用并有在线机器人版本，
但 `scopeInventory` 为 1,107/1,007（总权限/高级或超敏感权限），群目录
业务码为 0，但仍返回 0 个群。把某人设为应用管理员不等于把机器人加入群；“机器人已发布/
已允许发消息”的人工确认也不能替代 API 证据。必须在目标群的机器人管理中确认加入的是该
应用当前已发布版本，然后重新运行发现命令；只有返回目标 `chat_id` 后才可执行真实投递、
去重与失败恢复验收。

## 5. 用友

[用友开放平台](https://developer.yonyou.com/openAPI)的官方流程是注册、创建应用、申请服务、
企业授权后调用；并支持 IP 白名单、分层限流和熔断。

提供的 C4 人工登录账号只能供人在管理界面操作，**不能**作为服务器 API 凭据，也未写入代码、
环境模板、日志或 Git。2026-07-29 已用该账号只读验证：

- 可以通过 SSO 进入 YonSuite/C4 业务租户与用友开放平台；
- 开放平台控制台实际进入 `#/unregister`，说明当前账号尚未注册开发者/ISV 身份；
- 因此目前不存在可供 SCM 使用的企业应用 client ID/secret、已申请服务或企业应用授权。

当前收到的 AppKey/AppSecret 只满足凭据对中的一部分，仍缺租户、组织、token URL、base URL、
已申请服务及企业授权证据。当前保持 `contract_only`，避免在未知产品版本/租户/组织/接口下伪接通。未自动注册开发者身份，
因为注册会接受平台条款、创建外部主体并可能要求企业/伙伴资料，属于必须由企业明确批准的外部变更。

2026-08-03 再次执行无网络 readiness 审计：AppKey/AppSecret 均存在，但产品 profile、租户、
组织、获批 API 契约、允许主机、base URL 与 token URL 仍全部缺失，故 `safeToCall=false`。

所需机器配置：

```text
YY_APP_KEY
YY_APP_SECRET
YY_TENANT_ID
YY_ORG_ID
YY_PRODUCT_PROFILE
YY_APPROVED_API_CONTRACTS
YY_ALLOWED_HOSTS
YY_BASE_URL
YY_TOKEN_URL
```

`YY_PRODUCT_PROFILE` 只接受 `c4`、`yonsuite`、`yonbip`，必须由企业管理员/实施方确认；
不能从网页登录域名猜测。`YY_APPROVED_API_CONTRACTS` 是企业实际授权的精确 API 名称与版本，
逗号分隔，不能只写“采购”“财务”等泛称。`YY_ALLOWED_HOSTS` 只列企业/实施方确认的 base/token
精确主机名，不接受通配符、IP 或任意公网域名。主/别名凭据冲突、HTTP、带用户名密码、
IPv6 zone、loopback、私网或本地域名 endpoint 会被拒绝；未来 token 客户端还必须在连接前
重新解析 DNS、拒绝非公网地址并把已验证 IP 固定到同一次请求，避免 DNS rebinding。

在不请求 token、不调用业务 API 的情况下可先运行：

```bash
npx tsx src/jobs/cli.ts audit-yonyou-readiness
```

输出只包含配置存在性、产品类型、获批接口数量、缺失项和剩余控制；不会输出密钥、租户/组织、
endpoint 或接口名。即使结果为 `contract_ready`，实现仍为 `contract_only`、`safeToCall=false`；
沙箱只读握手与对账完成前不代表已接通。

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

## 6. 观测、告警与验收

运维面板把「代码就绪」「机器凭据已配」「业务流已启用」「契约已选择」「真实 Live UAT 已验证」
和「来源作用域身份异常已清零」分开显示；凭据存在不再自动等于 operational。配置/UAT 就绪与
最近运行健康也分开：空观察显示“空观察，旧批次保留”，只读 staging 显示“仅观察，不可放行”，
失败不会被绿色状态掩盖。飞书只展示当前实际配置路径可用的 webhook 或应用机器人能力。
面板还显示缺失环境变量、验证时间和阻塞说明。
生产 Compose 只把 `.env.prod` 中的连接器值原样传入容器；未设置值保持为空，
不在编排文件里内置凭据、开启同步或选中契约。CI 的 Static checks 使用固定版本的
Gitleaks 扫描完整 Git 历史；只有经人工核实的非秘密测试不变键和幂等 UUID 可用精确指纹排除。
运行与证据由以下事实证明：

- `integration_runs`：请求范围、源/落 staging/拒收行数、证据 hash/path、状态、错误；
- `integration_checkpoints`：最后成功游标、版本、时间和运行；
- `import_jobs` / `staging_rows`：来源日期、schema 版本、full/delta 范围、别名与拒收；
- `job_runs`：调度是否真正执行；
- `notifications`：飞书或站内投递状态。

上线门：

- 聚水潭真实握手、控制总量和 7 天恢复演练通过；
- 飞书测试群分别完成应用 UUID 去重与 webhook 业务码验证；应用超时不得触发跨渠道双发；
- 简道云完成密钥轮换、重复视图裁决、九条契约控制总量和失败恢复；
- 用友只读沙箱完成前不得标记 operational，更不得写财务事实；
- 密钥只存在部署密钥库/环境变量，轮换后旧值失效，日志与导出无 secret。
