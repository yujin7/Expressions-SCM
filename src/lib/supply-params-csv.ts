/**
 * 周期主数据「导出 → 线下填 → 导回」的列契约（2026-09-04 审计 #2）——**导出与导入共用同一份表头**。
 *
 * 事故形态：`/master/supply-params` 没有导出，唯一的导入适配器 `import/adapters/leadtime.ts`
 * 又死绑在两份供应商工作簿的页名（「生产周期统计」「生产周期明细」）与它们的列名上。
 * 业务想线下补一批周期，既拿不到一张空白表，也没有任何一种他们自己能造出来的文件能被系统接受——
 * 于是 5,376 个 SKU 里 4,856 个缺周期这件事，在系统里没有出口。
 *
 * 零依赖纯常量模块（禁止 import）：页面（`"use client"`）与服务端适配器都值导入本文件，
 * 保证「导出的表头」与「导入认的表头」永远是同一份；改一处即两处同时变
 * （`tests/import/sku-leadtime-simple.test.ts` 钉住往返一致）。
 */

/** 模板/导出的固定表头（顺序即列序；导入按名取列，不依赖列位置） */
export const SUPPLY_PARAMS_CSV_HEADERS = [
  "SKU编码",
  "名称",
  "分层",
  "品牌",
  "加工周期",
  "在途周期",
  "采购周期",
  "阻塞原因",
] as const;

/** 导入必须能识别的列（其余列忽略）：编码是键，三个周期是值 */
export const SUPPLY_PARAMS_CSV_KEY_HEADER = "SKU编码";
export const SUPPLY_PARAMS_CSV_LEAD_HEADERS = {
  normalLeadDays: "加工周期",
  logisticsLeadDays: "在途周期",
  purchaseLeadDays: "采购周期",
} as const;

/** 简版交期模板标识（上传模板列表 / staging targetTable / 放行动作共用一个字符串） */
export const SKU_LEADTIME_SIMPLE_TEMPLATE = "sku_leadtime_simple";

/** 工作表名：模板与导入认同一个名字（避免又变成"只有某份供应商文件能进"） */
export const SKU_LEADTIME_SIMPLE_SHEET = "周期补录";

/**
 * 空白模板的示例行——只用于让业务看懂每列填什么。
 * 导入时以 `SKU编码` 是否命中主档为准，示例行的编码不存在会被拒收并列在拒收清单里。
 */
export const SUPPLY_PARAMS_CSV_SAMPLE_ROW: readonly string[] = [
  "S1-示例编码",
  "（可留空，仅供人看）",
  "（可留空）",
  "（可留空）",
  "30",
  "15",
  "",
  "（可留空）",
];
