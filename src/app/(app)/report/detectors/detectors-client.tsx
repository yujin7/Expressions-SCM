"use client";

/**
 * E5-10 异动侦测：三条规则（销量骤停 / 渠道结构迁移 / 速度突变）的命中清单（只读）。
 * 命中即提示，不代表结论——页面顶部明确要求人工确认。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Card, Input, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { exportCsv } from "@/components/exportCsv";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import CaliberNote from "@/components/CaliberNote";

type DetectorKind = "sales_stop" | "channel_shift" | "velocity";

interface DetectorHit {
  kind: DetectorKind;
  severity: "high" | "medium";
  title: string;
  detail: string;
}

/** 一行 = 一个 SKU；同一 SKU 命中的多个侦测器合并在 hits 里，不再各占一行 */
interface DetectorRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  hits: DetectorHit[];
  severity: "high" | "medium";
  hitCount: number;
  onHand: number;
  lastQty: number;
}

interface DetectorData {
  rows: DetectorRow[];
  total: number;
  summary: {
    salesStop: number; channelShift: number; velocity: number;
    scanned: number; affectedSkus: number; multiHitSkus: number;
  };
  months: string[];
  maxYm: string | null;
  snapDate: string | null;
  thresholds: { salesDrop: number; channelShiftPct: number; velocityDeviation: number; minPeriods: number };
}

const KIND_LABEL: Record<DetectorKind, string> = {
  sales_stop: "销量骤停",
  channel_shift: "渠道迁移",
  velocity: "速度突变",
};
const KIND_COLOR: Record<DetectorKind, string> = {
  sales_stop: "red",
  channel_shift: "purple",
  velocity: "blue",
};
const SEVERITY_LABEL: Record<string, string> = { high: "高", medium: "中" };
const SEVERITY_COLOR: Record<string, string> = { high: "red", medium: "orange" };

const KIND_ORDER: DetectorKind[] = ["sales_stop", "channel_shift", "velocity"];

export default function DetectorsClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<DetectorData | null>(null);
  const [loading, setLoading] = useState(false);
  const listState = useListState({ key: "detectors", defaults: { q: "", kind: "" }, defaultPageSize: 50 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const kind = filters.kind;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (kind) params.set("kind", kind);
      setData(await fetchJson<DetectorData>(`/api/report/detectors?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, kind, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const doExport = async () => {
    const all: DetectorRow[] = [];
    for (let p = 1; p <= 40; p++) {
      const params = new URLSearchParams({ q, page: String(p), pageSize: "500" });
      if (kind) params.set("kind", kind);
      const d = await fetchJson<DetectorData>(`/api/report/detectors?${params.toString()}`);
      all.push(...d.rows);
      if (all.length >= d.total) break;
    }
    exportCsv(
      `异动侦测-${data?.maxYm ?? ""}`,
      ["类型", "严重度", "SKU编码", "名称", "品牌", "在库", "最近一期销量", "标题", "说明"],
      // 导出按「一次命中一行」展开——表格是给人看的（按 SKU 合并），CSV 是拿去透视的
      all.flatMap((r) =>
        r.hits.map((h) => [KIND_LABEL[h.kind], SEVERITY_LABEL[h.severity], r.code, r.name, r.brand, r.onHand, r.lastQty, h.title, h.detail]),
      ),
    );
  };

  const columns: ColumnsType<DetectorRow> = [
    {
      title: "命中",
      key: "hits",
      width: 190,
      fixed: "left",
      render: (_: unknown, r: DetectorRow) => (
        <Space size={4} wrap>
          {r.hits.map((h) => (
            <Tag color={KIND_COLOR[h.kind]} key={h.kind} style={{ marginInlineEnd: 0 }}>{KIND_LABEL[h.kind]}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "SKU 编码",
      dataIndex: "code",
      width: 155,
      render: (v: string) => <a href={`/report/sku-360?sku=${encodeURIComponent(v)}`}>{v}</a>,
    },
    { title: "名称", dataIndex: "name", width: 200, ellipsis: true },
    { title: "品牌", dataIndex: "brand", width: 100, render: (v: string | null) => v ?? "—" },
    {
      title: "在库",
      dataIndex: "onHand",
      width: 95,
      align: "right",
      render: (v: number) => (v > 0 ? formatQty(v) : <Typography.Text type="secondary">0</Typography.Text>),
    },
    { title: "最近一期销量", dataIndex: "lastQty", width: 110, align: "right", render: (v: number) => formatQty(v) },
    {
      title: "说明",
      key: "detail",
      render: (_: unknown, r: DetectorRow) => (
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          {r.hits.map((h) => (
            <div key={h.kind}>
              <Typography.Text strong>{h.title}</Typography.Text>
              <div style={{ fontSize: 12, color: "rgba(0,0,0,0.55)", lineHeight: 1.7 }}>{h.detail}</div>
            </div>
          ))}
        </Space>
      ),
    },
    {
      title: "严重度",
      dataIndex: "severity",
      width: 84,
      align: "center",
      render: (v: string) => <Tag color={SEVERITY_COLOR[v]}>{SEVERITY_LABEL[v]}</Tag>,
    },
  ];

  const s = data?.summary;
  const th = data?.thresholds;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>异动侦测</Typography.Title>
      <CaliberNote
        summary={
          <>
            三条规则化侦测跑现有月度数据，只列命中项（无异常不占位）。
            {data?.months.length ? <>　月窗 {data.months[0]} ~ {data.months[data.months.length - 1]}，最近一期 {data.maxYm}。</> : null}
            {data?.snapDate ? <>　在库含快照仓（时点 {data.snapDate}）。</> : null}
          </>
        }
        detail={
          <div>
            <p><b>销量骤停</b>：近 6 月全渠道月销序列，最近一期为 0，或较之前各期均值下跌超 {th ? th.salesDrop * 100 : 70}%。样本不足 {th?.minPeriods ?? 3} 期、或历史均值为 0 时不判定。</p>
            <p><b>渠道结构迁移</b>：最近两月各渠道占比（分母为该期总量），任一渠道占比变化超 {th?.channelShiftPct ?? 15} 个百分点。任一期总量为 0 时不判定。</p>
            <p><b>速度突变</b>：近 1 月日均（月销 ÷ 30.4）vs 近 3 月基线日均（窗口销量 ÷ 91），偏离超 ±{th ? th.velocityDeviation * 100 : 40}%。基线 ≤0 时不判定。两口径除数不同，小幅偏离属噪音。</p>
            <p>扫描范围：启用中的成品 SKU；在库 = 全网口径（实时账 + 各快照仓最新快照）。</p>
          </div>
        }
      />
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="规则化侦测，命中即提示，需人工确认"
        description="本页不是结论：销量归零可能是链接下架/失效，也可能是季节性、断货或换新链接；渠道位移可能是活动节奏。请结合链接状态、活动排期与实际库存核实后再决策。"
      />
      <Space size={12} wrap style={{ marginBottom: 12 }}>
        <Card size="small" style={{ minWidth: 150 }}>
          <Statistic title="销量骤停" value={s?.salesStop ?? 0} valueStyle={{ color: "#cf1322" }} suffix="项" />
        </Card>
        <Card size="small" style={{ minWidth: 150 }}>
          <Statistic title="渠道迁移" value={s?.channelShift ?? 0} valueStyle={{ color: "#722ed1" }} suffix="项" />
        </Card>
        <Card size="small" style={{ minWidth: 150 }}>
          <Statistic title="速度突变" value={s?.velocity ?? 0} valueStyle={{ color: "#1677ff" }} suffix="项" />
        </Card>
        <Card size="small" style={{ minWidth: 170 }}>
          {/* 三项之和 > 待看 SKU 数，差额就是同一 SKU 中多条的重叠量——把它摆出来，
              否则「554」会被读成「554 个东西要处理」，实际只有 343 个对象 */}
          <Statistic
            title="待看 SKU"
            value={s?.affectedSkus ?? 0}
            suffix={s ? `个（其中 ${s.multiHitSkus} 个中多条）` : "个"}
            valueStyle={{ color: "#d4380d" }}
          />
        </Card>
        <Card size="small" style={{ minWidth: 150 }}>
          <Statistic title="扫描成品 SKU" value={s?.scanned ?? 0} suffix="个" />
        </Card>
      </Space>
      <ListToolbar
        state={listState}
        onExport={() => void doExport()}
        extra={
          <>
            {KIND_ORDER.map((k) => (
              <Tag.CheckableTag
                key={k}
                checked={kind === k}
                onChange={(c) => listState.setFilter({ kind: c ? k : "" })}
                style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}
              >
                {KIND_LABEL[k]}（{k === "sales_stop" ? s?.salesStop ?? 0 : k === "channel_shift" ? s?.channelShift ?? 0 : s?.velocity ?? 0}）
              </Tag.CheckableTag>
            ))}
            <Input.Search
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索编码/名称"
              style={{ width: 240 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
          </>
        }
      />
      <Table<DetectorRow>
        rowKey={(r) => String(r.skuId)}
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: loading ? "加载中…" : "本期无命中——三条规则均未触发（无异常不占位）" }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => listState.setPage(p, ps),
        }}
      />
    </div>
  );
}
