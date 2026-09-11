"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Card, Col, Input, Modal, Row, Select, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, ScheduleOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { fetchJson, postJson } from "@/components/fetchJson";
import { exportCsv } from "@/components/exportCsv";
import ListToolbar from "@/components/ListToolbar";
import { metricTooltip } from "@/components/metrics";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import type { DataQualityReport, DqSourceRow } from "@/server/modules/report/data-quality";
import type { SalesConsistency, SalesConsistencyRow } from "@/server/modules/report/sales-consistency";
import type { DqReviewRow } from "@/server/modules/dq/reviews";
import type { BelowFloorList, ManualOverrideList, ManualOverrideRow } from "@/server/modules/dq/lists";

interface ReviewsResponse {
  data: DqReviewRow[];
  total: number;
  cadence: { cadence: "week" | "month"; streak: number; reason: string; periodKey: string };
}

const FRESH_LABEL: Record<string, { text: string; color: string }> = {
  current: { text: "正常", color: "success" },
  stale: { text: "过期", color: "error" },
  unknown: { text: "未知", color: "default" },
};
const ACC_LABEL: Record<string, { text: string; color: string }> = {
  ok: { text: "达标", color: "success" },
  below_target: { text: "低于目标", color: "error" },
  unknown: { text: "不度量", color: "default" },
};
const REVIEW_STATUS: Record<string, { text: string; color: string }> = {
  pending: { text: "待核对", color: "processing" },
  completed: { text: "已完成", color: "success" },
  waived: { text: "已豁免", color: "default" },
};
const FLAG_LABEL: Record<string, string> = {
  qty_jump: "总量跳变",
  vanished: "SKU 消失",
  negatives: "负数量",
  empty_prev: "无上一批",
};

const pct = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);

export default function DataQualityClient({ canReview }: { canReview: boolean }) {
  const { message } = App.useApp();
  const me = useMe();
  // 与 /api/report/data-quality 的 requireAnyRole(VIEW_ROLES) 一致；无权者不显示「重算」而不是点了再 403
  const canRefresh = hasAnyRole(me, "pmc", "finance", "warehouse", "purchasing");
  const [report, setReport] = useState<DataQualityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadReport = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await fetchJson<DataQualityReport>(`/api/report/data-quality${refresh ? "?refresh=1" : ""}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  /* ── 周核对清单（paramPrefix rv） ── */
  const reviewState = useListState({ key: "dq-reviews", defaults: { status: "" as string | undefined }, defaultPageSize: 20, paramPrefix: "rv" });
  const [reviews, setReviews] = useState<ReviewsResponse | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const loadReviews = useCallback(async () => {
    setReviewLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(reviewState.page), pageSize: String(reviewState.pageSize) });
      if (reviewState.filters.status) qs.set("status", reviewState.filters.status);
      setReviews(await fetchJson<ReviewsResponse>(`/api/dq/reviews?${qs.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setReviewLoading(false);
    }
  }, [reviewState.page, reviewState.pageSize, reviewState.filters.status, message]);
  useEffect(() => {
    void loadReviews();
  }, [loadReviews]);

  const [generating, setGenerating] = useState(false);
  const generatePack = useCallback(async () => {
    setGenerating(true);
    try {
      const r = await postJson<{ periodKey: string; created: number; existing: number }>("/api/dq/reviews", { action: "generate" });
      message.success(`核对包 ${r.periodKey}：新建 ${r.created} 项，已存在 ${r.existing} 项`);
      await Promise.all([loadReviews(), loadReport(true)]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [loadReviews, loadReport, message]);

  const [closing, setClosing] = useState<{ row: DqReviewRow; action: "complete" | "waive" } | null>(null);
  const [closeNote, setCloseNote] = useState("");
  const [closingBusy, setClosingBusy] = useState(false);
  const submitClose = useCallback(async () => {
    if (!closing) return;
    setClosingBusy(true);
    try {
      await postJson("/api/dq/reviews", { action: closing.action, id: closing.row.id, note: closeNote || undefined });
      message.success(closing.action === "complete" ? "已完成核对" : "已豁免");
      setClosing(null);
      setCloseNote("");
      await Promise.all([loadReviews(), loadReport(true)]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setClosingBusy(false);
    }
  }, [closing, closeNote, loadReviews, loadReport, message]);

  /* ── 一致性例外（paramPrefix sc） ── */
  const scState = useListState({ key: "dq-sales-consistency", defaults: { month: "" as string | undefined }, defaultPageSize: 20, paramPrefix: "sc" });
  const [consistency, setConsistency] = useState<SalesConsistency | null>(null);
  const [scLoading, setScLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setScLoading(true);
    fetchJson<SalesConsistency>("/api/report/data-quality?section=consistency")
      .then((r) => { if (!cancelled) setConsistency(r); })
      .catch((e: Error) => { if (!cancelled) message.error(e.message); })
      .finally(() => { if (!cancelled) setScLoading(false); });
    return () => { cancelled = true; };
  }, [message]);
  const scRows = useMemo(() => {
    const all = consistency?.exceptions ?? [];
    return scState.filters.month ? all.filter((r) => r.month === scState.filters.month) : all;
  }, [consistency, scState.filters.month]);
  const scPage = scRows.slice((scState.page - 1) * scState.pageSize, scState.page * scState.pageSize);

  /* ── C10 手工改写逐条清单（paramPrefix mo） ── */
  const moState = useListState({ key: "dq-manual-overrides", defaults: { yearMonth: "" as string | undefined }, defaultPageSize: 20, paramPrefix: "mo" });
  const [overrides, setOverrides] = useState<ManualOverrideList | null>(null);
  const [moLoading, setMoLoading] = useState(false);
  const loadOverrides = useCallback(async () => {
    setMoLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(moState.page), pageSize: String(moState.pageSize) });
      if (moState.filters.yearMonth) qs.set("yearMonth", moState.filters.yearMonth);
      setOverrides(await fetchJson<ManualOverrideList>(`/api/report/data-quality/manual-overrides?${qs.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setMoLoading(false);
    }
  }, [moState.page, moState.pageSize, moState.filters.yearMonth, message]);
  useEffect(() => { void loadOverrides(); }, [loadOverrides]);

  /* ── C10 低于量下限逐条清单（paramPrefix bf） ── */
  const bfState = useListState({ key: "dq-below-floor", defaults: { month: "" as string | undefined }, defaultPageSize: 20, paramPrefix: "bf" });
  const [belowFloor, setBelowFloor] = useState<BelowFloorList | null>(null);
  const [bfLoading, setBfLoading] = useState(false);
  const loadBelowFloor = useCallback(async () => {
    setBfLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(bfState.page), pageSize: String(bfState.pageSize) });
      if (bfState.filters.month) qs.set("month", bfState.filters.month);
      setBelowFloor(await fetchJson<BelowFloorList>(`/api/report/data-quality/below-floor?${qs.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBfLoading(false);
    }
  }, [bfState.page, bfState.pageSize, bfState.filters.month, message]);
  useEffect(() => { void loadBelowFloor(); }, [loadBelowFloor]);

  const sourceColumns: ColumnsType<DqSourceRow> = [
    { title: "来源", dataIndex: "label", width: 150, fixed: "left", render: (v: string, r) => <Tooltip title={`模板：${r.templates.join("、")}`}><span>{v}</span></Tooltip> },
    {
      title: "及时性", key: "timeliness", width: 190,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <Tooltip title={r.timeliness.basis}><span>
            <Tag color={FRESH_LABEL[r.timeliness.status]?.color}>{FRESH_LABEL[r.timeliness.status]?.text}</Tag>
            {r.timeliness.latestAsOf ?? "—"}
          </span></Tooltip>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.timeliness.ageDays == null ? "无时点" : `数据龄 ${r.timeliness.ageDays} 天（阈 ${r.timeliness.maxAgeDays}）`}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "完整性", key: "completeness", width: 150,
      render: (_v, r) => (
        <Tooltip title={r.completeness.basis}><span>
          {pct(r.completeness.rate)}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}> n={r.completeness.n}</Typography.Text>
        </span></Tooltip>
      ),
    },
    {
      title: "唯一性", key: "uniqueness", width: 150,
      render: (_v, r) => (
        <Tooltip title={r.uniqueness.basis}><span>
          {r.uniqueness.rate == null ? <Typography.Text type="secondary">不度量</Typography.Text> : pct(r.uniqueness.rate)}
          {r.uniqueness.duplicates > 0 ? <Typography.Text type="danger" style={{ fontSize: 12 }}> 重复 {r.uniqueness.duplicates}</Typography.Text> : null}
        </span></Tooltip>
      ),
    },
    {
      title: "准确性", key: "accuracy", width: 220,
      sorter: (a, b) => (a.accuracy.rate ?? -1) - (b.accuracy.rate ?? -1),
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <Tooltip title={r.accuracy.basis}><span>
            <Tag color={ACC_LABEL[r.accuracy.status]?.color}>{ACC_LABEL[r.accuracy.status]?.text}</Tag>
            {pct(r.accuracy.rate)}
            {r.accuracy.targetPct != null ? <Typography.Text type="secondary" style={{ fontSize: 12 }}> / 目标 {r.accuracy.targetPct}%</Typography.Text> : null}
          </span></Tooltip>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>n={r.accuracy.n}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "覆盖起止", key: "coverage", width: 200,
      render: (_v, r) => (
        <Tooltip title={r.coverage.basis}><span>{r.coverage.from ?? "—"} ~ {r.coverage.through ?? "—"}</span></Tooltip>
      ),
    },
  ];

  const reviewColumns: ColumnsType<DqReviewRow> = [
    { title: "周期", dataIndex: "periodKey", width: 110, fixed: "left", sorter: (a, b) => a.periodKey.localeCompare(b.periodKey), render: (v: string, r) => <span>{r.periodKind === "week" ? "周" : "月"} {v}</span> },
    { title: "来源", dataIndex: "sourceLabel", width: 140 },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <Tag color={REVIEW_STATUS[v]?.color}>{REVIEW_STATUS[v]?.text ?? v}</Tag> },
    {
      title: "生成时准确率", key: "accuracy", width: 160,
      render: (_v, r) => r.evidence ? `${pct(r.evidence.accuracy.rate)} / 目标 ${pct(r.evidence.targetAccuracyPct)}` : "—",
    },
    { title: "及时性", key: "fresh", width: 120, render: (_v, r) => r.evidence?.timeliness.latestAsOf ?? "—" },
    { title: "备注", dataIndex: "note", ellipsis: true },
    { title: "处理人", dataIndex: "reviewedByName", width: 100, render: (v: string | null) => v ?? "—" },
    { title: "处理时间", dataIndex: "reviewedAt", width: 150, render: (v: string | null) => (v ? dayjs(v).format("YYYY-MM-DD HH:mm") : "—") },
    {
      title: "操作", key: "actions", width: 150, fixed: "right",
      render: (_v, r) => r.status !== "pending" || !canReview ? <Typography.Text type="secondary">—</Typography.Text> : (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => { setClosing({ row: r, action: "complete" }); setCloseNote(""); }}>完成</Button>
          <Button type="link" size="small" danger onClick={() => { setClosing({ row: r, action: "waive" }); setCloseNote(""); }}>豁免</Button>
        </Space>
      ),
    },
  ];

  const scColumns: ColumnsType<SalesConsistencyRow> = [
    { title: "月份", dataIndex: "month", width: 90, fixed: "left", sorter: (a, b) => a.month.localeCompare(b.month) },
    { title: "SKU", dataIndex: "skuCode", width: 140, render: (v: string, r) => <Tooltip title={r.skuName}><span>{v}</span></Tooltip> },
    { title: "内部 sales_monthly", dataIndex: "internalQty", width: 140, align: "right" },
    { title: "天猫观察净件数", dataIndex: "externalQty", width: 140, align: "right" },
    { title: "差异", dataIndex: "diffQty", width: 110, align: "right", sorter: (a, b) => Math.abs(Number(a.diffQty)) - Math.abs(Number(b.diffQty)), render: (v: string) => <Typography.Text type="danger">{v}</Typography.Text> },
    { title: "差异 %", dataIndex: "diffPct", width: 90, align: "right", sorter: (a, b) => Math.abs(a.diffPct ?? 0) - Math.abs(b.diffPct ?? 0), render: (v: number | null) => pct(v) },
  ];

  const overrideColumns: ColumnsType<ManualOverrideRow> = [
    { title: "月份", dataIndex: "yearMonth", width: 90, fixed: "left", sorter: (a, b) => a.yearMonth.localeCompare(b.yearMonth) },
    { title: "口径", dataIndex: "scopeLabel", width: 140 },
    { title: "改写前", dataIndex: "previousAmount", width: 140, align: "right", render: (v: string | null) => v == null ? <Typography.Text type="secondary">无权限 / 无原行</Typography.Text> : v },
    { title: "改写后", dataIndex: "amount", width: 140, align: "right", render: (v: string | null) => v == null ? <Typography.Text type="secondary">无权限</Typography.Text> : <Typography.Text strong>{v}</Typography.Text> },
    { title: "币种", dataIndex: "currency", width: 70 },
    { title: "说明", dataIndex: "note", ellipsis: true, render: (v: string | null) => v ?? "—" },
    { title: "改写人", dataIndex: "createdByName", width: 100, render: (v: string | null) => v ?? "—" },
    { title: "改写时间", dataIndex: "createdAt", width: 150, render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm") },
  ];

  const exportOverrides = () => {
    if (!overrides) return;
    exportCsv(
      `数据质量-手工改写-${report?.today ?? ""}`,
      ["月份", "口径", "改写前", "改写后", "币种", "说明", "改写人", "改写时间"],
      overrides.rows.map((r) => [r.yearMonth, r.scopeLabel, r.previousAmount, r.amount, r.currency, r.note, r.createdByName, r.createdAt]),
      overrides.total > overrides.rows.length ? `仅导出当前页 ${overrides.rows.length} 行，共 ${overrides.total} 行` : undefined,
    );
  };
  const exportBelowFloor = () => {
    if (!belowFloor) return;
    exportCsv(
      `数据质量-低于量下限-${belowFloor.anchorDate ?? report?.today ?? ""}`,
      ["月份", "SKU", "名称", "内部 sales_monthly", "天猫观察净件数", "差异", "差异%"],
      belowFloor.rows.map((r) => [r.month, r.skuCode, r.skuName, r.internalQty, r.externalQty, r.diffQty, r.diffPct]),
      belowFloor.total > belowFloor.rows.length ? `仅导出当前页 ${belowFloor.rows.length} 行，共 ${belowFloor.total} 行` : undefined,
    );
  };

  const exportReviews = () => {
    if (!reviews) return;
    exportCsv(
      `数据质量核对清单-${reviews.cadence.periodKey}`,
      ["周期类型", "周期", "来源", "状态", "生成时准确率%", "目标%", "及时性时点", "备注", "处理人", "处理时间"],
      reviews.data.map((r) => [r.periodKind, r.periodKey, r.sourceLabel, REVIEW_STATUS[r.status]?.text ?? r.status, r.evidence?.accuracy.rate ?? "", r.evidence?.targetAccuracyPct ?? "", r.evidence?.timeliness.latestAsOf ?? "", r.note, r.reviewedByName, r.reviewedAt]),
      reviews.total > reviews.data.length ? `仅导出当前页 ${reviews.data.length} 行，共 ${reviews.total} 行` : undefined,
    );
  };
  const exportConsistency = () => {
    if (!consistency) return;
    exportCsv(
      `销量口径一致性例外-${consistency.anchorDate ?? report?.today ?? ""}`,
      ["月份", "SKU", "名称", "内部 sales_monthly", "天猫观察净件数", "差异", "差异%"],
      scRows.map((r) => [r.month, r.skuCode, r.skuName, r.internalQty, r.externalQty, r.diffQty, r.diffPct]),
    );
  };

  const sq = report?.snapshotQuality;

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>数据质量</Typography.Title>
      <Typography.Paragraph type="secondary">
        来源 × 维度只算能算的，算不出的留空并写明原因，不做综合分；观察数据 observation_only，不进过账、不定量。
        {report ? ` 数据截止 ${report.today} · 容差 ${report.tolerancePct}% · 口径 ${report.version}` : ""}
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {report?.unregisteredTemplates.length ? (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={`未登记来源类的导入模板：${report.unregisteredTemplates.join("、")}（请在 data-source-class 登记）`} />
      ) : null}

      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={12} md={6}>
          <Card size="small" title={<Tooltip title={metricTooltip("dataAccuracyRpa")}><span>RPA 仓库准确率</span></Tooltip>}>
            <Statistic value={report?.sources.find((s) => s.sourceClass === "rpa_warehouse")?.accuracy.rate ?? "—"} suffix="%" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              来源：自有实时仓出库（stock_ledger sales_out）vs 聚水潭日销一致率，非快照仓本身 · 盘点命中 {pct(report?.count.rate)}（{report?.count.lines ?? 0} 行）
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" title={<Tooltip title={metricTooltip("dataAccuracyManual")}><span>人工单据链准确率</span></Tooltip>}>
            <Statistic value={report?.sources.find((s) => s.sourceClass === "manual_po_chain")?.accuracy.rate ?? "—"} suffix="%" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" title={<Tooltip title={metricTooltip("salesConsistencyPct")}><span>销量口径一致率</span></Tooltip>}>
            <Statistic value={report?.salesConsistency.consistencyPct ?? "—"} suffix="%" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              比较 {report?.salesConsistency.comparedRows ?? 0} 行 · 例外 {report?.salesConsistency.exceptionRows ?? 0} ·
              比较月 {report?.salesConsistency.comparedMonths?.length ? report.salesConsistency.comparedMonths.join("、") : "无"}
              {report?.salesConsistency.skippedMonths?.length ? ` · 内部缺月 ${report.salesConsistency.skippedMonths.join("、")} 跳过` : ""} · 仅天猫
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" title={<Tooltip title={metricTooltip("snapshotJumpAlerts")}><span>快照跳变告警 / 待核对 / 手工改写</span></Tooltip>}>
            <Space size="large">
              <a href="#snapshot-quality"><Statistic value={sq?.alerts ?? "—"} suffix="仓" /></a>
              <a onClick={() => reviewState.setFilter({ status: "pending" })} href="#reviews"><Statistic value={report?.reviews.pending ?? "—"} suffix="项" /></a>
              <Tooltip title="点开看逐条改写记录（谁、什么时候、从多少改成多少）">
                <a href="#manual-overrides" onClick={() => moState.setFilter({ yearMonth: "" })}><Statistic value={report?.manualOverrides.count ?? "—"} suffix="项" /></a>
              </Tooltip>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              手工改写 {report?.manualOverrides.period ?? ""}，独立计数不进准确率 ·{" "}
              <a href="#below-floor">低于量下限 {consistency?.belowFloorRows ?? report?.salesConsistency.belowFloorRows ?? "—"} 行</a>（不进一致率分母）
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="来源 × 维度" style={{ marginBottom: 12 }}
        extra={canRefresh ? <Button icon={<ReloadOutlined />} size="small" loading={loading} onClick={() => void loadReport(true)}>重算</Button> : null}>
        <Table<DqSourceRow> rowKey="sourceClass" size="small" columns={sourceColumns} dataSource={report?.sources ?? []}
          loading={loading} pagination={false} scroll={{ x: 1060 }} />
        {report ? (
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "#8c8c8c", fontSize: 12 }}>
            {report.limitations.map((l) => <li key={l}>{l}</li>)}
          </ul>
        ) : null}
      </Card>

      <Card size="small" title="快照仓相邻批次对比" style={{ marginBottom: 12 }} id="snapshot-quality">
        <Table<DataQualityReport["snapshotQuality"]["warehouses"][number]> rowKey="warehouseId" size="small" pagination={false}
          dataSource={sq?.warehouses ?? []} loading={loading} locale={{ emptyText: "没有快照仓或尚无快照" }}
          columns={[
            { title: "仓库", dataIndex: "name", width: 160, render: (v: string, r) => `${r.code} ${v}` },
            { title: "上一批", dataIndex: "prevBizDate", width: 110, render: (v: string | null) => v ?? "—" },
            { title: "本批", dataIndex: "nextBizDate", width: 110 },
            { title: "行数", key: "rows", width: 120, render: (_v, r) => `${r.prevRows} → ${r.nextRows}` },
            { title: "总量变动", dataIndex: "qtyDeltaPct", width: 100, align: "right", sorter: (a, b) => Math.abs(a.qtyDeltaPct ?? 0) - Math.abs(b.qtyDeltaPct ?? 0), render: (v: number | null) => pct(v) },
            { title: "消失 SKU", key: "vanished", width: 120, render: (_v, r) => `${r.vanished}（${pct(r.vanishedPct)}）` },
            { title: "负数行", dataIndex: "negatives", width: 80, align: "right" },
            { title: "标记", dataIndex: "flags", render: (flags: string[]) => flags.length === 0 ? <Tag color="success">正常</Tag> : flags.map((f) => <Tag key={f} color={f === "empty_prev" ? "default" : "warning"}>{FLAG_LABEL[f] ?? f}</Tag>) },
          ]} />
      </Card>

      <Card size="small" style={{ marginBottom: 12 }} id="reviews"
        title={`核对清单${reviews ? `（当前节奏：${reviews.cadence.cadence === "week" ? "周核对" : "月核对"}，${reviews.cadence.reason}）` : ""}`}>
        <ListToolbar
          state={reviewState}
          onExport={reviews ? exportReviews : undefined}
          extra={
            <Select allowClear placeholder="状态" style={{ width: 140 }} value={reviewState.filters.status || undefined}
              onChange={(v) => reviewState.setFilter({ status: v ?? "" })}
              options={Object.entries(REVIEW_STATUS).map(([value, l]) => ({ value, label: l.text }))} />
          }
          primaryActions={
            <Space>
              <Button icon={<ReloadOutlined />} onClick={() => void loadReviews()}>刷新</Button>
              {canReview ? <Button type="primary" icon={<ScheduleOutlined />} loading={generating} onClick={() => void generatePack()}>生成本期核对包</Button> : null}
            </Space>
          }
        />
        <Table<DqReviewRow> rowKey="id" size={reviewState.tableSize} columns={reviewColumns} dataSource={reviews?.data ?? []}
          loading={reviewLoading} scroll={{ x: 1100 }} pagination={reviewState.paginationProps({ total: reviews?.total ?? 0 })}
          locale={{ emptyText: "暂无核对记录；点「生成本期核对包」或等待每周一自动生成" }} />
      </Card>

      <Card size="small" title="销量口径一致性例外（sales_monthly vs 天猫观察，SKU × 完整月）">
        {consistency ? (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            锚点 {consistency.anchorDate ?? "—"} · 阈值 相对 {consistency.thresholds.relPct}% / 绝对 {consistency.thresholds.absFloorQty} 件 / 量下限 {consistency.thresholds.minBaseQty} 件 ·
            一致 {consistency.consistentRows} / 例外 {consistency.exceptionRows} / 低于量下限 {consistency.belowFloorRows} ·
            仅内部 {consistency.uncovered.internalOnlyRows} 行 / 仅外部 {consistency.uncovered.externalOnlyRows} 行未覆盖 ·
            外部不完整/未覆盖月内部 {consistency.uncovered.internalOutsideRangeRows ?? 0} 行不比 ·
            比较月 {consistency.comparedMonths?.length ? consistency.comparedMonths.join("、") : "无"} ·
            内部缺月 {consistency.skippedMonths?.length ? consistency.skippedMonths.join("、") : "无"} ·
            外部不完整月 {consistency.partialMonths?.length ? consistency.partialMonths.join("、") : "无"}
            {consistency.gate ? ` · ${consistency.gate}` : ""}
          </Typography.Paragraph>
        ) : null}
        <ListToolbar
          state={scState}
          onExport={consistency ? exportConsistency : undefined}
          extra={
            <Select allowClear placeholder="月份" style={{ width: 140 }} value={scState.filters.month || undefined}
              onChange={(v) => scState.setFilter({ month: v ?? "" })}
              options={(consistency?.months ?? []).map((m) => ({ value: m, label: m }))} />
          }
        />
        <Table<SalesConsistencyRow> rowKey={(r) => `${r.skuId}:${r.month}`} size={scState.tableSize} columns={scColumns} dataSource={scPage}
          loading={scLoading} scroll={{ x: 760 }} pagination={scState.paginationProps({ total: scRows.length })}
          locale={{ emptyText: "没有一致性例外" }} />
        {consistency ? (
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "#8c8c8c", fontSize: 12 }}>
            {consistency.limitations.map((l) => <li key={l}>{l}</li>)}
          </ul>
        ) : null}
      </Card>

      <Card size="small" style={{ marginTop: 12 }} id="manual-overrides"
        title={`手工改写（DQ-6）逐条清单${overrides ? `：${overrides.total} 项` : ""}`}>
        <ListToolbar
          state={moState}
          onExport={overrides ? exportOverrides : undefined}
          extra={
            <Input allowClear placeholder="月份 YYYY-MM" style={{ width: 160 }} value={moState.filters.yearMonth || undefined}
              onChange={(e) => moState.setFilter({ yearMonth: e.target.value })} />
          }
        />
        <Table<ManualOverrideRow> rowKey="id" size={moState.tableSize} columns={overrideColumns} dataSource={overrides?.rows ?? []}
          loading={moLoading} scroll={{ x: 980 }} pagination={moState.paginationProps({ total: overrides?.total ?? 0 })}
          locale={{ emptyText: "没有手工改写记录（sales_amount_monthly 无 source=manual 的替代行）" }} />
        {overrides ? <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>{overrides.caliber}</Typography.Paragraph> : null}
      </Card>

      <Card size="small" style={{ marginTop: 12 }} id="below-floor"
        title={`低于量下限（不进一致率分母）逐条清单${belowFloor ? `：${belowFloor.total} 行` : ""}`}>
        <ListToolbar
          state={bfState}
          onExport={belowFloor ? exportBelowFloor : undefined}
          extra={
            <Select allowClear placeholder="月份" style={{ width: 140 }} value={bfState.filters.month || undefined}
              onChange={(v) => bfState.setFilter({ month: v ?? "" })}
              options={(belowFloor?.months ?? []).map((m) => ({ value: m, label: m }))} />
          }
        />
        <Table<SalesConsistencyRow> rowKey={(r) => `bf-${r.skuId}:${r.month}`} size={bfState.tableSize} columns={scColumns}
          dataSource={belowFloor?.rows ?? []} loading={bfLoading} scroll={{ x: 760 }}
          pagination={bfState.paginationProps({ total: belowFloor?.total ?? 0 })}
          locale={{ emptyText: belowFloor?.gate ?? "没有低于量下限的行" }} />
        {belowFloor ? <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>{belowFloor.caliber}</Typography.Paragraph> : null}
      </Card>

      <Modal
        open={closing != null}
        title={closing?.action === "complete" ? "完成核对" : "豁免核对"}
        okText={closing?.action === "complete" ? "完成" : "豁免"}
        confirmLoading={closingBusy}
        // 豁免原因服务端必填（dq/reviews 400）：不让用户点了才知道
        okButtonProps={{ disabled: closing?.action === "waive" && !closeNote.trim() }}
        onOk={() => void submitClose()}
        onCancel={() => setClosing(null)}
      >
        {closing ? (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Text>{closing.row.periodKey} · {closing.row.sourceLabel}</Typography.Text>
            <Input.TextArea rows={3} maxLength={500} value={closeNote} onChange={(e) => setCloseNote(e.target.value)}
              placeholder={closing.action === "waive" ? "豁免原因（必填）" : "核对说明（可选）"} />
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
