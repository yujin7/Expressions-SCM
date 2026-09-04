"use client";

/**
 * 过渡期运营提报核对（D55/R3）：运营按 SKU×渠道×月提报需求量，与系统基线（Holt 月量 / 朴素月均）并排，
 * 差异 ≥ 阈值标「需核对」。提报只对照不驱动建议量。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Col, Input, Modal, Row, Select, Space, Statistic, Switch, Table, Tag, Tooltip, Typography, Upload } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, UploadOutlined } from "@ant-design/icons";
import CaliberNote from "@/components/CaliberNote";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import SearchInput from "@/components/SearchInput";
import SkuHoverCard from "@/components/SkuHoverCard";
import { useListState } from "@/components/useListState";

interface ReconcileRow {
  submissionId: number;
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  channelId: number | null;
  channelName: string | null;
  period: string;
  submittedQty: string;
  basis: string | null;
  submittedBy: string | null;
  submittedAt: string;
  revisions: number;
  baselineQty: string | null;
  baselineMethod: string;
  naiveQty: string | null;
  diffPct: number | null;
  flagged: boolean;
  flagReason: string | null;
  /** W2-#7 处置结果；未处置 = null */
  disposition: { decision: "accepted" | "rejected"; agreedQty: string | null; reason: string | null; by: string | null; at: string } | null;
  /** 标红且未处置 —— 会被投影成复核项（责任角色 pmc）送到人面前 */
  needsDisposition: boolean;
}

interface ReconcileData {
  period: string;
  periods: string[];
  rows: ReconcileRow[];
  total: number;
  summary: {
    submissions: number; flagged: number; noBaseline: number; submittedQty: string; baselineQty: string;
    needsDisposition: number; accepted: number; rejected: number; agreedQty: string;
  };
  meta: { thresholdPct: number; months6: string[]; months3: string[]; maxYm: string | null; scopeForced: boolean };
  csvHeaders: string[];
}

interface ChannelOpt { id: number; code: string; name: string }

const TEMPLATE = "SKU编码,渠道编码,月份,数量,依据\nCP00001,tmall,2026-10,1200,双11预售\n";

export default function ReconcileClient({ canSubmit }: { canSubmit: boolean }) {
  const { message } = App.useApp();
  const listState = useListState({
    key: "replenish-reconcile",
    defaults: { q: "", period: "", channelId: "", flaggedOnly: "" },
    defaultPageSize: 50,
  });
  const { filters, page, pageSize } = listState;
  const [data, setData] = useState<ReconcileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelOpt[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ q: filters.q, page: String(page), pageSize: String(pageSize) });
      if (filters.period) params.set("period", filters.period);
      if (filters.channelId) params.set("channelId", filters.channelId);
      if (filters.flaggedOnly === "1") params.set("flaggedOnly", "1");
      setData(await fetchJson<ReconcileData>(`/api/replenish/reconcile?${params.toString()}`));
    } catch (e) {
      setData(null);
      setLoadError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [filters.q, filters.period, filters.channelId, filters.flaggedOnly, page, pageSize]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    fetchJson<{ data?: ChannelOpt[] }>("/api/master/channel?pageSize=200")
      .then((res) => setChannels(res.data ?? []))
      .catch(() => setChannels([]));
  }, []);

  /* W2-#7 处置：接受 / 驳回。写权限与提报同口径（ops/pmc，admin 兜底；服务端仍是权威）。 */
  const canDispose = canSubmit;
  const [rejectTarget, setRejectTarget] = useState<ReconcileRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [disposing, setDisposing] = useState(false);

  const dispose = useCallback(async (row: ReconcileRow, decision: "accepted" | "rejected", reason?: string) => {
    setDisposing(true);
    try {
      await fetchJson("/api/replenish/reconcile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId: row.submissionId, decision, reason: reason ?? null }),
      });
      message.success(decision === "accepted"
        ? `已把 ${row.code} ${row.period} 的运营提报记为一致需求（不自动驱动建议量）`
        : `已驳回 ${row.code} ${row.period} 的运营提报`);
      setRejectTarget(null);
      setRejectReason("");
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setDisposing(false);
    }
  }, [load, message]);
  const accept = useCallback((row: ReconcileRow) => dispose(row, "accepted"), [dispose]);

  const submitCsv = async () => {
    if (!csvText.trim()) return;
    setSubmitting(true);
    try {
      const res = await postJson<{ inserted: number; superseded: number; unchanged: number; parsedRows: number }>("/api/replenish/reconcile", { csv: csvText });
      message.success(`已提报 ${res.parsedRows} 行：新增 ${res.inserted}（其中修正 ${res.superseded}），未变化 ${res.unchanged}`);
      setImportOpen(false);
      setCsvText("");
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<ReconcileRow> = useMemo(() => [
    {
      title: "状态", dataIndex: "flagged", width: 100, fixed: "left",
      render: (v: boolean, r) => v
        ? <Tooltip title={r.flagReason}><Tag color={r.disposition ? "orange" : "red"}>需核对</Tag></Tooltip>
        : <Tag color="green">一致</Tag>,
    },
    {
      /* W2-#7：标红之后必须有下一步。接受 = 记为该期已达成一致的需求（仍不自动驱动建议量）；
         驳回必须写原因。未处置的标红行会投影成复核项（责任角色 PMC），不会停在看板上。 */
      title: "处置", key: "disposition", width: 190, fixed: "left",
      render: (_: unknown, r) => {
        if (r.disposition) {
          const d = r.disposition;
          const title = `${d.by ?? "未知用户"} 于 ${new Date(d.at).toLocaleString("zh-CN", { hour12: false })}${d.decision === "accepted" ? `接受为一致需求 ${d.agreedQty ?? ""}（不自动驱动建议量）` : `驳回：${d.reason ?? ""}`}`;
          return (
            <Tooltip title={title}>
              <Tag color={d.decision === "accepted" ? "blue" : "default"}>
                {d.decision === "accepted" ? "已接受为一致需求" : "已驳回"}
              </Tag>
            </Tooltip>
          );
        }
        if (!r.flagged) return <Typography.Text type="secondary">无需处置</Typography.Text>;
        if (!canDispose) return <Tooltip title="未处置的标红行已投影为复核项（责任角色 PMC）"><Tag color="red">待处置</Tag></Tooltip>;
        return (
          <Space size={4}>
            <a onClick={() => void accept(r)}>接受</a>
            <a onClick={() => setRejectTarget(r)}>驳回</a>
          </Space>
        );
      },
    },
    { title: "SKU 编码", dataIndex: "code", width: 140, render: (v: string) => <SkuHoverCard code={v} /> },
    { title: "名称", dataIndex: "name", width: 220, ellipsis: true },
    { title: "渠道", dataIndex: "channelName", width: 100, render: (v: string | null) => v ?? <Typography.Text type="secondary">不分渠道</Typography.Text> },
    { title: "月份", dataIndex: "period", width: 90 },
    { title: "运营提报", dataIndex: "submittedQty", width: 110, align: "right", render: (v: string, r) => <Space size={4}>{formatQty(v)}{r.revisions > 0 ? <Tag>改{r.revisions}次</Tag> : null}</Space> },
    {
      title: "系统基线（月）", dataIndex: "baselineQty", width: 130, align: "right",
      render: (v: string | null, r) => v == null
        ? <Typography.Text type="secondary">无序列</Typography.Text>
        : <Tooltip title={`Holt 预测（${r.baselineMethod}），近 6 月序列`}>{formatQty(v)}</Tooltip>,
    },
    { title: "近3月月均", dataIndex: "naiveQty", width: 110, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    {
      title: "差异", dataIndex: "diffPct", width: 100, align: "right",
      render: (v: number | null) => v == null ? "—" : <Typography.Text type={Math.abs(v) >= (data?.meta.thresholdPct ?? 30) ? "danger" : undefined}>{v > 0 ? "+" : ""}{v}%</Typography.Text>,
    },
    { title: "提报依据", dataIndex: "basis", width: 200, ellipsis: true, render: (v: string | null) => v ?? "—" },
    { title: "提报人", dataIndex: "submittedBy", width: 100, render: (v: string | null) => v ?? "—" },
    { title: "提报时间", dataIndex: "submittedAt", width: 150, render: (v: string) => v.slice(0, 16).replace("T", " ") },
  ], [data?.meta.thresholdPct, canDispose, accept]);

  const s = data?.summary;
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>运营提报核对（过渡期）</Typography.Title>
      <CaliberNote
        summary={<>运营按 SKU×渠道×月提报需求量，与系统基线并排；|差异| ≥ {data?.meta.thresholdPct ?? 30}% 标「需核对」。提报<b>只对照不驱动</b>建议量（D55）。</>}
        detail={
          <div>
            <p>系统基线 = Holt 月量预测（近 6 月序列，rules/forecast）；朴素基线 = 近 3 月月均。序列按同一 SKU×渠道取 sales_monthly（不分渠道 = 全渠道汇总），锚点与分层/补货同法。</p>
            <p>提报修正 = 新行替代旧行（append-only，链式留痕）；模板列：{data?.csvHeaders?.join("、") ?? "SKU编码、渠道编码、月份、数量、依据"}。阈值在运行参数 ops_demand_diff_pct 调整。</p>
            {data?.meta ? <p>销量窗口：{data.meta.months6.length ? `${data.meta.months6[0]} ~ ${data.meta.months6[data.meta.months6.length - 1]}` : "无销量数据"}{data.meta.scopeForced ? "；已按您的渠道范围裁剪" : ""}。</p> : null}
          </div>
        }
      />
      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col span={4}><Statistic title="提报行" value={s?.submissions ?? "—"} /></Col>
        <Col span={4}><Statistic title="需核对" value={s?.flagged ?? "—"} valueStyle={{ color: s && s.flagged > 0 ? "#cf1322" : undefined }} /></Col>
        <Col span={4}><Statistic title="待处置" value={s?.needsDisposition ?? "—"} valueStyle={{ color: s && s.needsDisposition > 0 ? "#cf1322" : undefined }} /></Col>
        <Col span={4}><Statistic title="已接受／已驳回" value={s ? `${s.accepted}／${s.rejected}` : "—"} /></Col>
        <Col span={4}><Statistic title="提报合计" value={s ? formatQty(s.submittedQty) : "—"} /></Col>
        <Col span={4}><Statistic title="已一致需求" value={s ? formatQty(s.agreedQty) : "—"} /></Col>
      </Row>
      {s && s.needsDisposition > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`${s.needsDisposition} 行标红且尚未处置——这些行已投影为复核项（责任角色 PMC），会出现在待办里，不会停在本页。`}
        />
      ) : null}
      <ListToolbar
        state={listState}
        extra={
          <>
            <Select
              placeholder="月份"
              allowClear
              style={{ width: 120 }}
              value={filters.period || undefined}
              options={(data?.periods ?? []).map((p) => ({ value: p, label: p }))}
              onChange={(v) => listState.setFilter({ period: v ?? "" })}
            />
            <Select
              placeholder="渠道"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 160 }}
              value={filters.channelId || undefined}
              options={channels.map((c) => ({ value: String(c.id), label: `${c.name}（${c.code}）` }))}
              onChange={(v) => listState.setFilter({ channelId: v ?? "" })}
            />
            <span>只看需核对 <Switch size="small" checked={filters.flaggedOnly === "1"} onChange={(v) => listState.setFilter({ flaggedOnly: v ? "1" : "" })} /></span>
            <SearchInput allowClear placeholder="搜索 SKU 编码/名称" style={{ width: 200 }} onSearch={(v) => listState.setFilter({ q: v.trim() })} />
          </>
        }
        primaryActions={
          <Space>
            {canSubmit ? <Button type="primary" icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>导入提报模板</Button> : null}
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          </Space>
        }
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="提报核对" />
      <Table<ReconcileRow>
        rowKey="submissionId"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
        locale={{ emptyText: loadError ? "数据未加载" : data?.periods.length ? "当前条件下无提报" : "尚无运营提报；请导入模板" }}
      />
      <Modal
        title="导入运营提报（CSV 模板）"
        open={importOpen}
        onOk={() => void submitCsv()}
        onCancel={() => setImportOpen(false)}
        confirmLoading={submitting}
        okText="提报"
        cancelText="取消"
        okButtonProps={{ disabled: !csvText.trim() }}
        width="min(720px, 100vw)"
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="列：SKU编码, 渠道编码(可空), 月份(YYYY-MM), 数量, 依据。同 SKU×渠道×月重复提报 = 修正（旧行留痕）。任一行出错整批不落。"
        />
        <Space style={{ marginBottom: 8 }}>
          <Upload
            accept=".csv,text/csv"
            showUploadList={false}
            beforeUpload={(file) => {
              file.text().then((t) => setCsvText(t)).catch(() => message.error("文件读取失败"));
              return false;
            }}
          >
            <Button icon={<UploadOutlined />}>选择 CSV 文件</Button>
          </Upload>
          <Button onClick={() => setCsvText(TEMPLATE)}>填入示例模板</Button>
        </Space>
        <Input.TextArea rows={10} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder={TEMPLATE} style={{ fontFamily: "monospace" }} />
      </Modal>
      <Modal
        title={rejectTarget ? `驳回运营提报：${rejectTarget.code} ${rejectTarget.period}` : "驳回运营提报"}
        open={rejectTarget != null}
        onOk={() => rejectTarget && void dispose(rejectTarget, "rejected", rejectReason)}
        onCancel={() => { setRejectTarget(null); setRejectReason(""); }}
        confirmLoading={disposing}
        okText="驳回"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: rejectReason.trim().length < 5 }}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="驳回必须写清原因（至少 5 个字）：没有原因的驳回等于沉默，运营下个月还会提同一个数。原因会留在审计里并回到提报人视野。"
        />
        <Input.TextArea
          rows={4}
          maxLength={500}
          showCount
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="例如：该活动已取消，按 8 月实际动销执行"
        />
      </Modal>
    </div>
  );
}
