"use client";

/** E4-03 到货日历：未结供给按预计到货日排成收货计划（只读；空档日保留占位，无交期条数顶部明示） */
import { useMemo, useState } from "react";
import { Alert, Button, Card, DatePicker, Empty, Space, Spin, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import DecisionVisual from "@/components/DecisionVisual";
import ProductExternalDecisionEvidenceCard from "@/components/ProductExternalDecisionEvidenceCard";
import ExportButton from "@/components/ExportButton";
import { useDocumentRead } from "@/components/useDocumentRead";
import { purchaseLineHref } from "@/lib/document-links";
import { formatQty } from "@/components/format";
import SkuHoverCard from "@/components/SkuHoverCard";
import { buildSupplyExternalEvidenceBrief } from "@/components/supply-external-evidence";
import type { ProductExternalDecisionEvidenceBrief } from "@/components/product-external-decision-evidence";
import type { JiandaoyunSupportingObservation } from "@/server/modules/report/jiandaoyun-supporting-observation";
import type { PromiseReliability } from "@/server/modules/report/supply-commitment";

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
  promiseReliability: PromiseReliability;
  supportingObservations: JiandaoyunSupportingObservation[];
  externalDecisionEvidence: ProductExternalDecisionEvidenceBrief;
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
const displayExternalMetric = (value: string): string => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("zh-CN", { maximumFractionDigits: 4 })
    : value;
};

function SupplyExternalEvidence({ observations }: { observations: readonly JiandaoyunSupportingObservation[] }) {
  const brief = buildSupplyExternalEvidenceBrief(observations);
  return (
    <Card
      size="small"
      title="简道云采购需求旁证（历史观察，不改承诺）"
      extra={<Button type="link" size="small" href="/import/exceptions?status=open&scope=JIANDAOYUN">处理身份认领</Button>}
      style={{ marginBottom: 12 }}
    >
      <Alert
        banner
        showIcon
        type="warning"
        message="需求/已采购数量是原表跨 SKU 控制量，单位未统一，不得据此计算采购达成率、生成 PO、改写在途或补货数量。"
        style={{ marginBottom: 10 }}
      />
      {brief.state === "missing" ? (
        <Typography.Text type="secondary">尚无最新成功批次；保持未知，不显示为 0 需求。</Typography.Text>
      ) : (
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Text type="secondary">源截止 {brief.sourceAsOf ?? "未提供"} · 业务期 {brief.period}</Typography.Text>
          <Space size={[6, 6]} wrap>
            {brief.metrics.map((metric) => (
              <Tag key={metric.key}>{metric.label} {displayExternalMetric(metric.value)}{metric.unit}</Tag>
            ))}
          </Space>
          <Space size={[6, 6]} wrap>
            {brief.identities.map((identity) => (
              <Tag color={identity.openValues > 0 ? "orange" : "default"} key={identity.kind}>
                {identity.label} {identity.governedMatches}/{identity.distinctValues} · 待认领 {identity.openValues}
              </Tag>
            ))}
          </Space>
        </Space>
      )}
    </Card>
  );
}

const PROMISE_STATUS = {
  on_time_in_full: { label: "按期足量", color: "green" },
  late_full: { label: "迟到补齐", color: "orange" },
  overdue_short: { label: "逾期未齐", color: "red" },
} as const;

const PROMISE_VERSION_LABEL = {
  immutable_history: "不可变版本完整",
  mixed_history: "新版本链＋历史快照",
  current_only: "仅当前承诺",
} as const;

export default function InboundCalendarClient() {
  const today = dayjs().format("YYYY-MM-DD");
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs(), dayjs().add(14, "day")]);
  const params = new URLSearchParams({ from: range[0].format("YYYY-MM-DD"), to: range[1].format("YYYY-MM-DD") });
  const read = useDocumentRead<CalendarData>(`/api/report/inbound-calendar?${params}`);
  const data = read.data;
  const loading = read.phase === "loading";

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
  const promise = data?.promiseReliability;
  const promiseChart = promise
    ? [
        { name: "按期足量", current: promise.totals.onTimeInFull, original: promise.originalTotals.onTimeInFull },
        { name: "迟到补齐", current: promise.totals.lateFull, original: promise.originalTotals.lateFull },
        { name: "逾期未齐", current: promise.totals.overdueShort, original: promise.originalTotals.overdueShort },
      ]
    : [];
  const promiseColumns: ColumnsType<PromiseReliability["exceptions"][number]> = [
    { title: "口径", dataIndex: "basis", width: 100, render: (value: "original" | "current") => value === "original" ? <Tag color="purple">原始承诺</Tag> : <Tag>当前承诺</Tag> },
    { title: "采购单 / 行", dataIndex: "docNo", width: 190, sorter: (a, b) => a.docNo.localeCompare(b.docNo),
      render: (value: string, row) => <a href={purchaseLineHref(row.poId, row.lineId) ?? undefined} title={`打开 ${value}，核对采购行 #${row.lineId}`}>
        {value}<br /><Typography.Text type="secondary">采购行 #{row.lineId}</Typography.Text>
      </a> },
    { title: "供应商", dataIndex: "supplierName", width: 160, ellipsis: true },
    { title: "SKU", dataIndex: "skuCode", width: 145, render: (value: string) => <SkuHoverCard code={value} /> },
    { title: "名称", dataIndex: "skuName", width: 190, ellipsis: true },
    { title: "判断承诺日", dataIndex: "promisedDate", width: 120, sorter: (a, b) => a.promisedDate.localeCompare(b.promisedDate) },
    { title: "改期", dataIndex: "revisionCount", width: 76, align: "right", sorter: (a, b) => a.revisionCount - b.revisionCount },
    {
      title: "状态", dataIndex: "status", width: 104,
      render: (value: keyof typeof PROMISE_STATUS) => {
        const item = PROMISE_STATUS[value];
        return <Tag color={item.color}>{item.label}</Tag>;
      },
    },
    { title: "迟延天数", dataIndex: "daysLate", width: 100, align: "right", defaultSortOrder: "descend", sorter: (a, b) => a.daysLate - b.daysLate },
    { title: "订购量", dataIndex: "orderedQty", width: 100, align: "right", render: (value: number, row) => `${formatQty(value)} ${row.baseUom}` },
    { title: "截止实收", dataIndex: "receivedAsOf", width: 105, align: "right", render: (value: number) => formatQty(value) },
    { title: "仍缺", dataIndex: "shortQty", width: 90, align: "right", sorter: (a, b) => a.shortQty - b.shortQty, render: (value: number) => formatQty(value) },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>到货日历</Typography.Title>
      {read.error ? <Alert type="error" showIcon message="到货与承诺数据读取失败，已撤回旧结果"
        description={read.error} action={<Button onClick={read.retry}>重试读取</Button>} style={{ marginBottom: 12 }} /> : null}
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

      {data ? <><SupplyExternalEvidence observations={data.supportingObservations} />
        <ProductExternalDecisionEvidenceCard evidence={data.externalDecisionEvidence} /></> : null}

      <DecisionVisual
        title="采购承诺可信度（版本化基线）"
        question="已到期采购承诺中，多少在原始承诺日前按基础单位足量兑现；改期是否掩盖迟延？"
        metricId="promiseReliability"
        grain={promise?.grain ?? "采购行（收货来源可核对）"}
        unit="采购承诺行占比"
        source={{
          tier: "ledger",
          source: "SCM 采购单、质检接收与采购退货事件",
          asOf: promise?.asOf,
          note: "原始与当前承诺分列；外部三边未通过 UAT 前不并入口径",
        }}
        coverage={{
          covered: promise?.totals.eligibleLines ?? 0,
          total: promise
            ? promise.totals.eligibleLines + promise.totals.ambiguous + promise.totals.controlMismatch
            : 0,
          label: "到期且可安全归属的采购承诺行",
        }}
        activeFilters={promise
          ? [
              `观察窗：${promise.windowFrom} 至 ${promise.asOf}`,
              `承诺版本：${PROMISE_VERSION_LABEL[promise.promiseVersionState]}`,
              `原始版本覆盖：${promise.coverage.historyPct == null ? "未知" : `${promise.coverage.historyPct.toFixed(1)}%`}`,
              "数量：基础单位",
              "收货归属不清的行排除",
              "缺失不补零",
            ]
          : []}
        summary={promise?.originalRate != null
          ? `原始承诺可信度 ${promise.originalRate.toFixed(1)}%；当前承诺口径 ${promise.rate == null ? "未知" : `${promise.rate.toFixed(1)}%`}。原始口径按期 ${promise.originalTotals.onTimeInFull} 行、迟到补齐 ${promise.originalTotals.lateFull} 行、逾期未齐 ${promise.originalTotals.overdueShort} 行。`
          : promise?.rate != null
            ? `当前承诺基线 ${promise.rate.toFixed(1)}%；${promise.historyGate ?? "原始承诺版本仍不足。"}`
            : promise?.gate ?? "正在计算供给承诺基线。"}
        caveat={[promise?.historyGate, ...(promise?.limitations ?? [])].filter(Boolean).join(" ")}
        state={read.error ? "error" : loading ? "loading" : promise?.state === "ready" ? "ready" : "insufficient"}
        stateDetail={read.error ?? promise?.gate ?? undefined}
        height={270}
        extra={promise ? <ExportButton href={`/api/export/supply-commitment?${new URLSearchParams({ asOf: promise.asOf, windowDays: String(promise.windowDays) })}`} label="导出全部承诺例外" /> : undefined}
        dataView={(
          <>
          <Typography.Paragraph type="secondary">
            {promise ? `预览 ${promise.exceptions.length} / ${promise.exceptionTotal} 条（原始与当前承诺分别计一条）；列排序仅作用于本预览。` : "尚未加载例外。"}
            导出读取同一观察窗口的全部例外，不受预览条数限制；读取执行时最新事实，不是页面快照。超过50,000条会明确标注截断。
          </Typography.Paragraph>
          <Table
            rowKey={(row) => `${row.basis}:${row.lineId}`}
            size="small"
            pagination={false}
            columns={promiseColumns}
            dataSource={promise?.exceptions ?? []}
            scroll={{ x: 1480 }}
          />
          </>
        )}
      >
        <ResponsiveContainer minWidth={0} minHeight={1}>
          <BarChart data={promiseChart} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis allowDecimals={false} />
            <RechartsTooltip formatter={(value) => [`${Number(value)} 行`, "采购承诺"]} />
            <Legend />
            <Bar dataKey="original" name="原始承诺" fill="#722ed1" radius={[4, 4, 0, 0]} />
            <Bar dataKey="current" name="当前承诺" fill="#1677ff" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </DecisionVisual>

      <Space style={{ marginBottom: 16 }} wrap>
        <DatePicker.RangePicker
          allowClear={false}
          value={range}
          onChange={(v) => { if (v?.[0] && v[1]) setRange([v[0], v[1]]); }}
        />
        <Button onClick={read.retry} icon={<ReloadOutlined />} loading={loading}>刷新</Button>
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
