"use client";

import { Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Block } from "@/server/modules/report/cockpit";
import type { TurnoverWindowCell, TurnoverWindowRow, TurnoverWindowsBlock } from "@/server/modules/report/cockpit-trends";
import { metricLabel, Muted, qty, TrendCard } from "./shared";

function CellValue({ c }: { c: TurnoverWindowCell }) {
  if (c.suppressed) {
    return <Tooltip title={c.reason ?? "压制"}><Typography.Text type="secondary">—</Typography.Text></Tooltip>;
  }
  return <span>{c.turns} <Typography.Text type="secondary">/ {c.dio ?? "—"}d</Typography.Text></span>;
}

/** 屏3 · 三窗口（30/90/365 天）周转与 DIO 并列——同日三窗口是无需新算的趋势代理 */
export function TurnoverWindowsCard({ block }: { block: Block<TurnoverWindowsBlock> }) {
  const d = block.data;
  const windows = d?.windows ?? [];
  const columns: ColumnsType<TurnoverWindowRow> = [
    { title: "地区", dataIndex: "regionCode", width: 70 },
    { title: "仓库", dataIndex: "name", ellipsis: true },
    { title: "在库", dataIndex: "onHand", align: "right", width: 100, render: (v: string) => qty(v) },
    ...windows.map((w, i) => ({
      title: `${w} 天 周转 / DIO`, key: `w${w}`, align: "right" as const, width: 130,
      render: (_: unknown, r: TurnoverWindowRow) => r.windows[i] ? <CellValue c={r.windows[i]} /> : "—",
    })),
  ];
  return (
    <TrendCard
      block={block}
      title={`${metricLabel("warehouseTurns", "逐仓周转次数")} · 30 / 90 / 365 天窗口并列`}
      question="周转是在恶化还是改善？同一天看三个窗口，短窗口低于长窗口意味着近期放缓。"
      metricId="warehouseTurns"
      grain="实时仓 × 窗口"
      unit="年化周转次数 / 库存天数"
      contentIsTable
      fitContent
      height={220}
      summary={d ? `窗口 ${d.windows.join("/")} 天；总周转 ${d.summary.map((c) => c.suppressed ? "—" : String(c.turns)).join(" / ")}；${d.rows.length} 个实时仓` : "无数据"}
    >
      {(data) => (
        <div>
          <Space wrap size={[8, 4]} style={{ marginBottom: 8 }}>
            {data.summary.map((c) => (
              <Tag key={c.windowDays} color={c.suppressed ? "default" : "processing"}>
                {c.windowDays} 天：{c.suppressed ? `— （${c.reason}）` : `周转 ${c.turns} · ${metricLabel("warehouseDio", "DIO")} ${c.dio ?? "—"} 天 · 出库 ${qty(c.outboundQty)}`}
              </Tag>
            ))}
          </Space>
          <Table<TurnoverWindowRow> rowKey="warehouseId" size="small" pagination={false} scroll={{ x: 640 }} dataSource={data.rows} columns={columns} />
          <Muted>只算实时仓（快照仓无流水不计算）；出库含调拨/发料/盘亏；窗口覆盖不完整（流水最早日 {data.ledgerFirstDay ?? "—"} 晚于窗口起点）或零出库时压制不显示。</Muted>
        </div>
      )}
    </TrendCard>
  );
}
