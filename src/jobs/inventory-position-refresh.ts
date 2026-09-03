/**
 * 库存日级/月级读模型刷新任务（D51/D52/D54）：重建 `inventory-position/v1` 与 `inventory-sales-ratio/v1`。
 *
 * 只写 report_read_model_cache（派生数据，可随时重建），不写台账、不写审计（与 rollup / snapshot-age 同形态）。
 * 页面读缓存；绑定（流水 max(id)、最新快照批次、成本版本、口径日）变化时页面也会兜底重算，
 * 本任务的意义是把重算从请求热路径挪到定时点（建议 11:35 / 17:35 Asia/Shanghai，跟在简道云同步之后）。
 * 未在 interval-runner / scheduler 登记——由编排方按 manifest.jobsToRegister 接入。
 */
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { refreshInventoryPosition } from "@/server/modules/report/inventory-position";
import { refreshInventorySalesRatio } from "@/server/modules/report/inventory-sales-ratio";

export interface InventoryPositionRefreshSummary {
  builtAt: string;
  positionBinding: string;
  ratioBinding: string;
  today: string;
  dailyPoints: number;
  monthEndPoints: number;
  warehouses: number;
  ratioRows: number;
  /** 当月占比（null = 缺任一侧） */
  currentRatioPct: number | null;
}

export async function runInventoryPositionRefresh(
  dbArg?: AnyDb,
  opts: { today?: string; historyMonths?: number } = {},
): Promise<InventoryPositionRefreshSummary> {
  const db = await resolveDb(dbArg);
  const position = await refreshInventoryPosition(db, opts);
  const ratio = await refreshInventorySalesRatio(db, opts);
  return {
    builtAt: ratio.builtAt,
    positionBinding: position.sourceBinding,
    ratioBinding: ratio.sourceBinding,
    today: position.today,
    dailyPoints: position.daily.length,
    monthEndPoints: position.monthEnd.length,
    warehouses: position.warehouses.length,
    ratioRows: ratio.rows.length,
    currentRatioPct: ratio.current.ratioMonthEndPct,
  };
}
