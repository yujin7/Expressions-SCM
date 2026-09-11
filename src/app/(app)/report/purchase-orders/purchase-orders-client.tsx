"use client";

import { useLatestRead } from "@/components/useLatestRead";

/**
 * D63 采购订单指标（真报表）：采购下了多少、多久到、省了多少、供应商 OTIF。
 * W2：OTIF 主口径改为**原始承诺**，当前承诺并列为副列——供应商改期不再抬高主口径。
 * 只消费读模型 purchase-order-metrics（版本号唯一权威是服务端的 PURCHASE_ORDER_METRICS_KEY 常量——
 * 这里不再抄一份 /vN，抄下来的那份只会随升版静默过期）；金额由 API 按角色剥离（moneyVisible=false 时显示「—」）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Card, Col, Row, Segmented, Select, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import CaliberNote from "@/components/CaliberNote";
import { exportCsv } from "@/components/exportCsv";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import { metricTooltip } from "@/components/metrics";
import SearchInput from "@/components/SearchInput";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import type {
  CycleStats, OtifStats, PoBrandRow, PoMonthRow, PoSupplierRow, PurchaseOrderMetrics,
} from "@/server/modules/report/purchase-order-metrics";

type Dim = "month" | "supplier" | "brand";
/** API 在读模型之外附带 availableYears（有已下单事实的年份，恒含当年），年份下拉不再取浏览器时钟 */
type PurchaseOrderMetricsResponse = PurchaseOrderMetrics & { availableYears?: number[] };

const money = (v: string | null | undefined): string =>
  v == null ? "—" : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const days = (v: number | null): string => (v == null ? "—" : `${v} 天`);
const pct = (v: number | null): string => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

function CycleCell({ c }: { c: CycleStats }) {
  if (c.insufficient) return <Tooltip title={`样本 ${c.n} < 3`}><Typography.Text type="secondary">样本不足（{c.n}）</Typography.Text></Tooltip>;
  return (
    <Tooltip title={`首批 P50/P90 = ${days(c.firstP50)} / ${days(c.firstP90)}（n=${c.n}）；全收 P50/P90 = ${days(c.fullP50)} / ${days(c.fullP90)}（n=${c.nFull}）`}>
      <span>{days(c.firstP50)} / {days(c.firstP90)} <Typography.Text type="secondary">(n={c.n})</Typography.Text></span>
    </Tooltip>
  );
}

function OtifCell({ o }: { o: OtifStats }) {
  const detail = `命中 ${o.hit} / 可评 ${o.evaluable}；待评 ${o.pending}；缺承诺日不可评 ${o.unevaluable}`;
  if (o.rate == null) return <Tooltip title={detail}><Typography.Text type="secondary">不可评</Typography.Text></Tooltip>;
  return (
    <Tooltip title={detail}>
      <Typography.Text style={{ color: o.rate < 0.8 ? "#cf1322" : "#52c41a" }}>{pct(o.rate)}</Typography.Text>
    </Tooltip>
  );
}

/**
 * 「没数据 ≠ 差」（`rules/scorecard.ts` 的既定规则，本页此前违反）。
 *
 * 此前 OTIF 用 `?? -1`、周期用 `?? MAX_SAFE_INTEGER` 参与比较：一个**没有可评 PO** 的供应商
 * 于是被排成「−100% 准时率」「周期最长」——升序时它顶在最差的位置，被当成最该处理的对象。
 * 缺数据是我们没记录，不是供应商的表现（记分卡也因此对缺数据的维度不计分而不是给 0 分）。
 *
 * 规则：有值的按值比；**没有值的一律沉底，升序降序都沉底**。
 * AntD 对 `descend` 会把比较结果整体取反，所以这里必须消费第三个参数 `sortOrder` 预先反号，
 * 否则「沉底」在降序时会变成「置顶」——把「没数据」排成「最好」，同样是假结论。
 */
export function compareNullLast(
  a: number | null | undefined,
  b: number | null | undefined,
  sortOrder?: "ascend" | "descend" | null,
): number {
  const av = a ?? null;
  const bv = b ?? null;
  if (av == null && bv == null) return 0;
  if (av == null || bv == null) {
    const last = av == null ? 1 : -1;
    return sortOrder === "descend" ? -last : last;
  }
  return av - bv;
}

export default function PurchaseOrdersClient() {
  const { message } = App.useApp();
  const me = useMe();
  const canRefresh = hasAnyRole(me, "pmc", "purchasing");
  const [data, setData] = useState<PurchaseOrderMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const listState = useListState({ key: "purchase-orders", defaults: { dim: "month", q: "", year: "" }, defaultPageSize: 20 });
  const { filters } = listState;
  const dim = (filters.dim || "month") as Dim;
  const q = (filters.q ?? "").trim().toLowerCase();
  const year = filters.year ?? "";

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (year) params.set("year", year);
      const qs = params.toString();
      const latestReadResult = await fetchJson<PurchaseOrderMetricsResponse>(`/api/report/purchase-orders${qs ? `?${qs}` : ""}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setData(latestReadResult);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      const text = e instanceof Error ? e.message : "采购订单指标加载失败";
      setData(null);
      setLoadError(text);
      message.error(text);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, year, message]);
  useEffect(() => { void load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await postJson("/api/report/purchase-orders", {});
      message.success("读模型已重建");
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  // 年份来自读模型事实（availableYears，降序、恒含当年）；未加载前只列当前选中年，避免用浏览器时钟猜
  const yearOptions = useMemo(() => {
    const years = data?.availableYears?.length ? data.availableYears : (data ? [data.year] : (year ? [Number(year)] : []));
    return years.map((y) => ({ value: String(y), label: `${y} 年` }));
  }, [data, year]);
  const currentYearValue = data?.availableYears?.[0] != null ? String(data.availableYears[0]) : (yearOptions[0]?.value ?? "");

  const supplierRows = useMemo(
    () => (data?.bySupplier ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q)),
    [data, q],
  );
  const brandRows = useMemo(
    () => (data?.byBrand ?? []).filter((r) => !q || r.brandName.toLowerCase().includes(q) || (r.brandCode ?? "").toLowerCase().includes(q)),
    [data, q],
  );

  const s = data?.summary;
  const mv = data?.moneyVisible ?? false;

  const volumeColumns = <T extends PoMonthRow | PoSupplierRow | PoBrandRow>(): ColumnsType<T> => [
    { title: "已下单 PO", dataIndex: "poCount", width: 100, align: "right" },
    { title: "行数", dataIndex: "lineCount", width: 80, align: "right" },
    { title: "数量（基础单位）", dataIndex: "orderedBaseQty", width: 140, align: "right", render: (v: string) => formatQty(v) },
    { title: <Tooltip title={metricTooltip("poOrderedAmount")}>未税金额</Tooltip>, dataIndex: "netAmount", width: 140, align: "right", render: (v: string | null) => money(v) },
    { title: "含税金额", dataIndex: "grossAmount", width: 140, align: "right", render: (v: string | null) => money(v) },
  ];

  const monthColumns: ColumnsType<PoMonthRow> = [
    { title: "月份", dataIndex: "month", width: 100, fixed: "left" },
    ...volumeColumns<PoMonthRow>(),
  ];
  const supplierColumns: ColumnsType<PoSupplierRow> = [
    {
      title: "供应商", dataIndex: "name", width: 220, fixed: "left", ellipsis: true,
      render: (v: string, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{v}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.code}</Typography.Text>
        </Space>
      ),
    },
    ...volumeColumns<PoSupplierRow>(),
    { title: <Tooltip title={metricTooltip("poOrderToDeliveryDays")}>订单→交付 P50/P90</Tooltip>, dataIndex: "cycle", width: 200, sorter: (a, b, order) => compareNullLast(a.cycle.firstP50, b.cycle.firstP50, order), render: (c: CycleStats) => <CycleCell c={c} /> },
    { title: <Tooltip title={metricTooltip("supplierOtif")}>{`OTIF（${data?.otifBasisLabel ?? "原始承诺"}）`}</Tooltip>, dataIndex: "otif", width: 130, align: "right", sorter: (a, b, order) => compareNullLast(a.otif.rate, b.otif.rate, order), render: (o: OtifStats) => <OtifCell o={o} /> },
    {
      title: <Tooltip title="并列副口径：按供应商改期后的当前承诺判定，只展示不进目标/评分——两列出现差额即说明改期吃掉了迟到">{`OTIF（${data?.otifSecondaryBasisLabel ?? "当前承诺"}）`}</Tooltip>,
      dataIndex: "otifCurrent", width: 130, align: "right",
      sorter: (a, b, order) => compareNullLast(a.otifCurrent.rate, b.otifCurrent.rate, order),
      render: (o: OtifStats) => <OtifCell o={o} />,
    },
    { title: <Tooltip title={metricTooltip("costSavingYtd")}>降本额</Tooltip>, dataIndex: ["costSaving", "savingYtd"], width: 120, align: "right", sorter: (a, b) => Number(a.costSaving.savingYtd ?? 0) - Number(b.costSaving.savingYtd ?? 0), render: (v: string | null) => money(v) },
    { title: "涨本额（另列）", dataIndex: ["costSaving", "increaseYtd"], width: 120, align: "right", render: (v: string | null) => money(v) },
    {
      title: "可比行", dataIndex: ["costSaving", "comparableLines"], width: 100, align: "right",
      render: (v: number, r) => `${v} / ${v + r.costSaving.nonComparableLines}`,
    },
  ];
  const brandColumns: ColumnsType<PoBrandRow> = [
    {
      title: "品牌", dataIndex: "brandName", width: 200, fixed: "left",
      render: (v: string, r) => (r.brandId == null ? <Tag>未归属品牌</Tag> : <span>{v} <Typography.Text type="secondary">{r.brandCode}</Typography.Text></span>),
    },
    ...volumeColumns<PoBrandRow>(),
  ];

  const onExport = () => {
    if (!data) return;
    if (dim === "month") {
      exportCsv(`采购订单指标-按月-${data.year}`, ["月份", "已下单PO", "行数", "数量", "未税金额", "含税金额"],
        data.byMonth.map((r) => [r.month, r.poCount, r.lineCount, r.orderedBaseQty, r.netAmount, r.grossAmount]));
    } else if (dim === "supplier") {
      exportCsv(`采购订单指标-按供应商-${data.year}`,
        ["供应商编码", "供应商", "已下单PO", "行数", "数量", "未税金额", "含税金额", "首批P50", "首批P90", "周期样本", "OTIF(原始承诺)", "可评", "待评", "不可评", "OTIF(当前承诺)", "可评(当前承诺)", "降本额", "涨本额", "可比行", "不可比行"],
        supplierRows.map((r) => [
          r.code, r.name, r.poCount, r.lineCount, r.orderedBaseQty, r.netAmount, r.grossAmount,
          r.cycle.firstP50, r.cycle.firstP90, r.cycle.n, r.otif.rate == null ? null : (r.otif.rate * 100).toFixed(1), r.otif.evaluable, r.otif.pending, r.otif.unevaluable,
          r.otifCurrent.rate == null ? null : (r.otifCurrent.rate * 100).toFixed(1), r.otifCurrent.evaluable,
          r.costSaving.savingYtd, r.costSaving.increaseYtd, r.costSaving.comparableLines, r.costSaving.nonComparableLines,
        ]));
    } else {
      exportCsv(`采购订单指标-按品牌-${data.year}`, ["品牌编码", "品牌", "已下单PO", "行数", "数量", "未税金额", "含税金额"],
        brandRows.map((r) => [r.brandCode, r.brandName, r.poCount, r.lineCount, r.orderedBaseQty, r.netAmount, r.grossAmount]));
    }
  };

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>采购订单指标</Typography.Title>
      <CaliberNote
        summary={<span>已下单 = PO 审批通过时点；订单→交付 = 审批 → 首批收货；降本只计降价，涨价另列不轧差（D63）。{data ? ` 截至 ${data.asOf}` : ""}{data && !mv ? " · 当前角色不可见金额" : ""}</span>}
        detail={
          <div>
            <p>金额为采购订单口径（未税为主、含税并列），不是应付。</p>
            <p>来源：SCM PO / SH / 审批事实（不含简道云旧采购单）· 时点：{data ? `读模型 ${data.builtAt.slice(0, 16).replace("T", " ")} 构建，截至 ${data.asOf}` : "加载中"}
              {data ? ` · 已批 PO 累计 ${data.summary.orderedPoAllTime} 张` : ""}
              {data && data.summary.invalidLines > 0 ? ` · ${data.summary.invalidLines} 行因换算系数非法未计入` : ""}
            </p>
          </div>
        }
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="采购订单指标加载失败"
          description={loadError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>重试</Button>}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Row gutter={[10, 10]} style={{ marginBottom: 12 }}>
        <Col xs={24} sm={12} xl={6}>
          <Card size="small">
            <Statistic
              title={<Tooltip title={metricTooltip("poOrderedQty")}>本月已下单（{data?.month ?? "—"}）</Tooltip>}
              value={s ? s.thisMonth.poCount : "—"}
              suffix={s ? `单 / ${formatQty(s.thisMonth.orderedBaseQty)} 件` : undefined}
            />
            <Typography.Text type="secondary">年累计 {s ? `${s.ytd.poCount} 单 / ${formatQty(s.ytd.orderedBaseQty)} 件` : "—"}</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card size="small">
            <Statistic title={<Tooltip title={metricTooltip("poOrderedAmount")}>本月已下单金额（未税）</Tooltip>} value={s && mv ? money(s.thisMonth.netAmount) : "—"} />
            <Typography.Text type="secondary">
              含税 {s && mv ? money(s.thisMonth.grossAmount) : "—"} · 年累计未税 {s && mv ? money(s.ytd.netAmount) : "—"}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card size="small">
            <Statistic
              title={<Tooltip title={metricTooltip("poOrderToDeliveryDays")}>订单→交付 P50 / P90</Tooltip>}
              value={s ? (s.cycle.insufficient ? "样本不足" : `${days(s.cycle.firstP50)} / ${days(s.cycle.firstP90)}`) : "—"}
              valueStyle={s?.cycle.insufficient ? { color: "#8c8c8c", fontSize: 18 } : undefined}
            />
            <Typography.Text type="secondary">首批样本 n={s?.cycle.n ?? "—"} · 全收 P50 {s ? days(s.cycle.fullP50) : "—"}（n={s?.cycle.nFull ?? "—"}）</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card size="small">
            <Statistic
              title={<Tooltip title={metricTooltip("costSavingYtd")}>成本下降 YTD（基线 {data?.baselineYear ?? "—"} 年）</Tooltip>}
              value={s && mv ? money(s.costSaving.savingYtd) : "—"}
              valueStyle={{ color: "#52c41a" }}
            />
            <Typography.Text type="secondary">
              涨本另列 {s && mv ? money(s.costSaving.increaseYtd) : "—"} · 可比行 {s ? `${s.costSaving.comparableLines} / ${s.costSaving.comparableLines + s.costSaving.nonComparableLines}` : "—"}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card size="small">
            <Statistic
              title={<Tooltip title={metricTooltip("supplierOtif")}>{`供应商 OTIF（年累计 · ${data?.otifBasisLabel ?? "原始承诺"}）`}</Tooltip>}
              value={s?.otif.rate == null ? "不可评" : pct(s.otif.rate)}
              valueStyle={{ color: s?.otif.rate == null ? "#8c8c8c" : s.otif.rate < 0.8 ? "#cf1322" : "#52c41a" }}
            />
            <Typography.Text type="secondary">
              可评 {s?.otif.evaluable ?? "—"} · 待评 {s?.otif.pending ?? "—"} · 缺承诺日 {s?.otif.unevaluable ?? "—"}（窗口 {data?.params.otifWindowDays ?? "—"} 天）
              <br />
              {data?.otifSecondaryBasisLabel ?? "当前承诺"}口径 {s?.otifCurrent.rate == null ? "不可评" : pct(s.otifCurrent.rate)}（可评 {s?.otifCurrent.evaluable ?? "—"}）——
              两者的差额来自供应商在确认门户里的改期，只展示不计入目标
              <br />
              承诺版本链：可信 {data?.promiseHistory.trusted ?? 0} / 迁移快照 {data?.promiseHistory.backfilled ?? 0} / 无版本链 {data?.promiseHistory.missing ?? 0} 行
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <ListToolbar
        state={listState}
        onExport={data ? onExport : undefined}
        primaryActions={canRefresh ? (
          <Button size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={() => void refresh()}>重建读模型</Button>
        ) : undefined}
        extra={
          <>
            <Segmented
              size="small"
              value={dim}
              onChange={(v) => listState.setFilter({ dim: String(v) })}
              options={[{ label: "按月", value: "month" }, { label: "按供应商", value: "supplier" }, { label: "按品牌", value: "brand" }]}
            />
            <Select
              size="small"
              style={{ width: 120 }}
              value={year || currentYearValue || undefined}
              options={yearOptions}
              onChange={(v) => listState.setFilter({ year: v === currentYearValue ? "" : v })}
            />
            {dim !== "month" ? (
              <SearchInput
                key={q}
                allowClear
                size="small"
                defaultValue={q}
                placeholder={dim === "supplier" ? "搜索供应商编码/名称" : "搜索品牌"}
                style={{ width: 220 }}
                onSearch={(v) => listState.setFilter({ q: v.trim() })}
              />
            ) : null}
          </>
        }
      />

      {dim === "month" ? (
        <Table<PoMonthRow>
          rowKey="month"
          size={listState.tableSize}
          columns={monthColumns}
          dataSource={data?.byMonth ?? []}
          loading={loading}
          scroll={{ x: "max-content" }}
          pagination={false}
          locale={{ emptyText: loadError ? "数据未加载" : "无已下单记录" }}
        />
      ) : dim === "supplier" ? (
        <Table<PoSupplierRow>
          rowKey="supplierId"
          size={listState.tableSize}
          columns={supplierColumns}
          dataSource={supplierRows}
          loading={loading}
          scroll={{ x: "max-content" }}
          pagination={listState.paginationProps({ total: supplierRows.length, showTotal: (t) => `共 ${t} 家` })}
          locale={{ emptyText: loadError ? "数据未加载" : "当前年份无已下单供应商" }}
        />
      ) : (
        <Table<PoBrandRow>
          rowKey={(r) => String(r.brandId ?? "none")}
          size={listState.tableSize}
          columns={brandColumns}
          dataSource={brandRows}
          loading={loading}
          scroll={{ x: "max-content" }}
          pagination={listState.paginationProps({ total: brandRows.length, showTotal: (t) => `共 ${t} 个品牌` })}
          locale={{ emptyText: loadError ? "数据未加载" : "当前年份无已下单记录" }}
        />
      )}

      {data ? (
        <Card size="small" title="口径与限制" style={{ marginTop: 12 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.limitations.map((l) => <li key={l}><Typography.Text type="secondary">{l}</Typography.Text></li>)}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
