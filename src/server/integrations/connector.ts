/**
 * #20 外部系统连接器脚手架（聚水潭/用友/飞书 实时对接的插入点）。
 *
 * 现状（诚实标注）：本系统的数据循环靠文件周更 + 新鲜度看门狗（jobs/freshness.ts）。
 * 实时对接需要各系统的 API 凭据与接口契约（属用户划出的「IT part」），不在本次可交付范围。
 * 本文件定义统一连接器契约，IT 对接时按此实现 fetchInventorySnapshot / fetchSalesMonthly，
 * 复用既有导入放行管线（transit_refs / stock_snapshots / sales_monthly）落库——
 * 一旦接通，覆盖缺口(#A)、数据过期(#B)、口径漂移三类问题同时消除。
 *
 * 落地路径（IT 实施）：
 * 1. 实现一个 Connector（如 JstConnector），凭据从环境变量读取（JST_APP_KEY 等）；
 * 2. 注册到 CONNECTORS；
 * 3. 新增 interval-runner 任务：每日拉取 → 走 createImportJob/release 管线（与文件导入同口径同幂等）；
 * 4. 拉取成功即刷新 transit_refs.createdAt，看门狗自动关闭对应过期提醒。
 */

export interface InventorySnapshotRow {
  skuCode: string;
  warehouseCode: string;
  qty: string; // decimal 字符串
  bizDate: string; // YYYY-MM-DD
}
export interface SalesMonthlyRow {
  skuCode: string;
  yearMonth: string; // YYYY-MM
  qty: string;
  channel?: string;
}

export interface Connector {
  /** 连接器标识（jst=聚水潭 / yy=用友 / feishu=飞书） */
  key: string;
  label: string;
  /** ready=代码已接通；contract_only=只有契约，禁止因凭据存在就宣称可用 */
  implementation: "ready" | "contract_only";
  requiredEnv: string[];
  blocker?: string;
  /** 是否已配置凭据（环境变量齐全）——未配置时对接任务应优雅跳过 */
  isConfigured(): boolean;
  /** 拉取库存快照（未实现则抛 NotImplemented） */
  fetchInventorySnapshot?(sinceDate: string): Promise<InventorySnapshotRow[]>;
  /** 拉取月度销量 */
  fetchSalesMonthly?(yearMonth: string): Promise<SalesMonthlyRow[]>;
}

export class NotImplementedError extends Error {
  constructor(key: string, method: string) {
    super(`连接器 ${key} 未实现 ${method}（IT 对接待接入——见 src/server/integrations/connector.ts）`);
  }
}

function hasEnv(keys: string[]): boolean {
  return keys.every((key) => Boolean(process.env[key]?.trim()));
}

/**
 * 集成目录不是“成功清单”：未实现的系统也注册，但明确标为 contract_only。
 * 这样运维页能看见真实缺口，同时 `configuredConnectors()` 绝不会把脚手架当成可运行连接器。
 */
export const CONNECTORS: Connector[] = [
  {
    key: "jst",
    label: "聚水潭（库存/销量）",
    implementation: "contract_only",
    requiredEnv: ["JST_APP_KEY", "JST_APP_SECRET"],
    blocker: "待 IT 提供 API 凭据、租户信息与字段契约；当前继续走受控文件导入",
    isConfigured() {
      return hasEnv(this.requiredEnv);
    },
    async fetchInventorySnapshot() {
      throw new NotImplementedError("jst", "fetchInventorySnapshot");
    },
    async fetchSalesMonthly() {
      throw new NotImplementedError("jst", "fetchSalesMonthly");
    },
  },
  {
    key: "yy",
    label: "用友（财务/成本）",
    implementation: "contract_only",
    requiredEnv: ["YY_CLIENT_ID", "YY_CLIENT_SECRET"],
    blocker: "待成本口径 D2、API 凭据与接口契约确认",
    isConfigured() {
      return hasEnv(this.requiredEnv);
    },
  },
  {
    key: "feishu",
    label: "飞书通知",
    implementation: "ready",
    requiredEnv: ["FEISHU_WEBHOOK_URL"],
    blocker: "代码已接通；配置 webhook 后启用",
    isConfigured() {
      return hasEnv(this.requiredEnv);
    },
  },
];

/** 供对接任务查询：返回已配置凭据的连接器 */
export function configuredConnectors(): Connector[] {
  return CONNECTORS.filter((c) => c.implementation === "ready" && c.isConfigured());
}

export interface ConnectorReadiness {
  key: string;
  label: string;
  implementation: Connector["implementation"];
  configured: boolean;
  operational: boolean;
  requiredEnv: string[];
  blocker: string | null;
}

export function getConnectorReadiness(): ConnectorReadiness[] {
  return CONNECTORS.map((connector) => {
    const configured = connector.isConfigured();
    return {
      key: connector.key,
      label: connector.label,
      implementation: connector.implementation,
      configured,
      operational: connector.implementation === "ready" && configured,
      requiredEnv: connector.requiredEnv,
      blocker: connector.blocker ?? null,
    };
  });
}
