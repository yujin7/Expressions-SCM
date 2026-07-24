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

/** 已注册连接器（IT 对接时在此登记实现实例）。当前为空——文件周更仍为唯一数据源。 */
export const CONNECTORS: Connector[] = [];

/** 供对接任务查询：返回已配置凭据的连接器 */
export function configuredConnectors(): Connector[] {
  return CONNECTORS.filter((c) => c.isConfigured());
}
