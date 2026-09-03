/**
 * 告警关闭原因码（零依赖纯常量，客户端可安全导入）。
 *
 * 唯一定义处：`src/db/schema/system.ts` 与 `alerts/engine.ts` 从这里取值（schema 再导出保持既有 import 路径）。
 * 本文件禁止 import 任何模块——`"use client"` 组件值导入 `@/db` / `@/server` 会把 pg / auth 拖进客户端包
 * （tests/architecture/client-server-boundary.test.ts）。
 */

/** alert_events.reason_code 全集（与 CHECK 约束一致；auto_hysteresis 只允许引擎写） */
export const ALERT_CLOSE_REASON_CODES = ["fixed", "false_positive", "wont_fix", "superseded", "auto_hysteresis", "manual"] as const;
export type AlertCloseReasonCode = (typeof ALERT_CLOSE_REASON_CODES)[number];

/** 人工关闭可选原因（auto_hysteresis 保留给引擎） */
export const MANUAL_CLOSE_REASON_CODES = ["fixed", "false_positive", "wont_fix", "superseded", "manual"] as const;
export type ManualCloseReasonCode = (typeof MANUAL_CLOSE_REASON_CODES)[number];

/** 中文标签与一句话说明（表单下拉与台账展示共用） */
export const ALERT_CLOSE_REASON_LABELS: Record<AlertCloseReasonCode, { label: string; hint: string }> = {
  fixed: { label: "已处理", hint: "问题已解决（补货已安排 / 参数已修正 / 单据已处理）" },
  false_positive: { label: "误报", hint: "告警判断不成立（阈值或日销估计偏差），进入误报复盘" },
  wont_fix: { label: "不处理", hint: "已评估、接受该风险，不采取行动" },
  superseded: { label: "已被取代", hint: "同对象已有更新的告警或单据接管" },
  manual: { label: "其他（人工）", hint: "以上都不贴切，请在备注说明" },
  auto_hysteresis: { label: "引擎自动关闭", hint: "命中条件消失后由引擎迟滞关闭（非人工）" },
};
