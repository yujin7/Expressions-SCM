"use client";

/** E4-03 到货日历：未结供给按预计到货日排成收货计划（只读；空档日保留占位，无交期条数顶部明示） */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Card, DatePicker, Empty, Space, Spin, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import SkuHoverCard from "@/components/SkuHoverCard";

interface CalendarLine {
  skuId: number;
  code: string;
  name: string;
  qty: number;
  uom: string;
  source: string;
  ref: string | null;
}

interface CalendarDay {
  date: string;
  weekday: string;
  lines: CalendarLine[];
  totalQty: number;
  lineCount: number;
}

interface CalendarData {
  from: string;
  to: string;
  days: CalendarDay[];
  summary: {
    totalLines: number;
    totalQty: number;
    undatedLines: number;
    bySource: Record<string, number>;
  };
}

/** 来源中文名与配色（与 server/modules/report/inbound-calendar.ts SUPPLY_SOURCE_LABELS 保持一致） */
const SOURCE_LABELS: Record<string, string> = {
  po: "采购在途",
  wo: "委外在制",
  legacy_fg: "存量单",
  on_order: "在订未出",
};
const SOURCE_COLORS: Record<string, string> = {
  po: "blue",
  wo: "purple",
  legacy_fg: "default",
  on_order: "default",
};

const nz = (v: number): string => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });

export default function InboundCalendarClient() {
  const { message } = App.useApp();
  const today = dayjs().format("YYYY-MM-DD");
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs(), dayjs().add(14, "day")]);
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        from: range[0].format("YYYY-MM-DD"),
        to: range[1].format("YYYY-MM-DD"),
      });
      setData(await fetchJson<CalendarData>(`/api/report/inbound-calendar?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range, message]);
  useEffect(() => { void load(); }, [load]);

  const columns: ColumnsType<CalendarLine> = useMemo(
    () => [
      {
        title: "SKU 编码",
        dataIndex: "code",
        width: 155,
        render: (v: string) => <SkuHoverCard code={v} />,
      },
      { title: "名称", dataIndex: "name", ellipsis: true },
      {
        title: "预计到货量",
        dataIndex: "qty",
        width: 140,
        align: "right",
        render: (v: number, r) => (
          <span>
            <b>{formatQty(v)}</b> <Typography.Text type="secondary">{r.uom}</Typography.Text>
          </span>
        ),
      },
      {
        title: "来源",
        dataIndex: "source",
        width: 110,
        render: (v: string) => (
          <Tag color={SOURCE_COLORS[v] ?? "default"} style={{ marginInlineEnd: 0 }}>
            {SOURCE_LABELS[v] ?? v}
          </Tag>
        ),
      },
      {
        title: "单号",
        dataIndex: "ref",
        width: 170,
        render: (v: string | null) => v ?? <Typography.Text type="secondary">—</Typography.Text>,
      },
    ],
    [],
  );

  const sourceBreakdown = data
    ? Object.entries(data.summary.bySource)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${SOURCE_LABELS[k] ?? k} ${nz(v)}`)
        .join(" · ")
    : "";

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>到货日历</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="仓库不该每天被动开门收货。本页把 PO 预计到货日、WO 交期、存量单预计入仓日汇成一张收货计划。"
        description={
          <Typography.Text type="secondary">
            数据源为<b>未结供给唯一口径</b>（采购在途按行未收量、委外在制按 WO 计划产出、存量单按台账未入库余量）；
            采购行交期优先于头交期。委外在制以 WO <b>计划产出量</b>计（未净已分批实收），执行中单据的残余量会偏高。
            存量单属外部台账登记（只读参考），到货日可信度低于系统内单据。
            <br />
            <b>逾期不补算</b>：到货日早于起始日的未结供给不会被堆到今天——要看逾期请把起始日往前调。
          </Typography.Text>
        }
      />
      {data && data.summary.undatedLines > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`另有 ${data.summary.undatedLines} 条未结供给无确认到货日，未出现在日历上（补录 PO 预计到货日 / WO 交期后可见）`}
          description={
            <Typography.Text type="secondary">
              日历越空不代表没货要来，也可能是交期没录。这批货是<b>看不见的到货</b>——仓库无法排班、缺料无法预警。
            </Typography.Text>
          }
        />
      ) : null}

      <Space style={{ marginBottom: 16 }} wrap>
        <DatePicker.RangePicker
          allowClear={false}
          value={range}
          onChange={(v) => { if (v?.[0] && v[1]) setRange([v[0], v[1]]); }}
        />
        <a onClick={() => { void load(); }}><ReloadOutlined /> 刷新</a>
        {data ? (
          <Space className="compact-stat-strip compact-stat-strip--inline" wrap>
            <Statistic title="预计到货条数" value={data.summary.totalLines} valueStyle={{ fontSize: 20 }} />
            <Statistic title="预计到货总量" value={nz(data.summary.totalQty)} valueStyle={{ fontSize: 20 }} />
            <Statistic
              title="无到货日条数"
              value={data.summary.undatedLines}
              valueStyle={{ fontSize: 20, color: data.summary.undatedLines > 0 ? "#faad14" : undefined }}
            />
          </Space>
        ) : null}
      </Space>
      {sourceBreakdown ? (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary">区间内按来源（数量）：{sourceBreakdown}</Typography.Text>
        </div>
      ) : null}

      <Spin spinning={loading}>
        {data && data.days.length === 0 ? <Empty description="区间内无日期" /> : null}
        <Space direction="vertical" size={12} style={{ display: "flex" }}>
          {(data?.days ?? []).map((d) => {
            const isToday = d.date === today;
            const isWeekend = d.weekday === "周六" || d.weekday === "周日";
            return (
              <Card
                key={d.date}
                size="small"
                styles={{ body: { padding: d.lineCount > 0 ? 0 : 12 } }}
                style={isToday ? { borderColor: "#1677ff", borderWidth: 2 } : undefined}
                title={
                  <Space>
                    <b style={{ color: isToday ? "#1677ff" : undefined }}>{d.date}</b>
                    <Typography.Text type={isWeekend ? "warning" : "secondary"}>{d.weekday}</Typography.Text>
                    {isToday ? <Tag color="blue">今天</Tag> : null}
                  </Space>
                }
                extra={
                  d.lineCount > 0 ? (
                    <Space>
                      <Tag>{d.lineCount} 条</Tag>
                      <Tag color="green" style={{ marginInlineEnd: 0 }}>合计 {nz(d.totalQty)}</Tag>
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  )
                }
              >
                {d.lineCount > 0 ? (
                  <Table<CalendarLine>
                    rowKey={(r) => `${r.skuId}-${r.source}-${r.ref ?? ""}-${r.qty}`}
                    size="small"
                    columns={columns}
                    dataSource={d.lines}
                    pagination={false}
                    scroll={{ x: "max-content" }}
                  />
                ) : (
                  <Typography.Text type="secondary">当日无预计到货</Typography.Text>
                )}
              </Card>
            );
          })}
        </Space>
      </Spin>
    </div>
  );
}
