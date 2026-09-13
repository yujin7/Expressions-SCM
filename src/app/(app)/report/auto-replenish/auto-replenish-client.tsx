"use client";

import { useLatestRead } from "@/components/useLatestRead";

/** 自动补货候选（守护式）——把 A/B×X/Y·非覆盖缺口·有生产周期的告急 SKU 挑出批量生成草稿；其余转人工（只读+人工闸 R13）。 */
import { useCallback, useEffect, useState } from "react";
import {  App, Button, Popconfirm, Space, Statistic, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { useMe, hasAnyRole, type Me } from "@/components/useMe";
import BhCreateRecovery, { useBhCreateRecovery } from "@/components/BhCreateRecovery";
import CaliberNote from "@/components/CaliberNote";
import LoadErrorAlert from "@/components/LoadErrorAlert";

/** E1-03：与 createReplenishDraftSchema 的 200 项上限对齐（服务端契约） */
const DRAFT_MAX = 200;

interface Candidate {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  cell: string;
  daysCover: number | null;
  suggestQty: string | null;
  baseUom: string;
  leadDays: number | null;
}

interface Exception extends Candidate {
  reason: string;
}

interface AutoData {
  candidates: Candidate[];
  exceptions: Exception[];
  summary: { candidateCount: number; exceptionCount: number; totalSuggestQty: string };
}

const ABC_COLORS: Record<string, string> = { A: "red", B: "orange", C: "blue" };
const cellColor = (cell: string): string => ABC_COLORS[cell[0]] ?? "default";

const skuLink = (v: string) => <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>;
const cellTag = (v: string) => <Tag color={cellColor(v)}>{v}</Tag>;
const coverRender = (v: number | null) =>
  v == null ? <Typography.Text type="secondary">无动销</Typography.Text> : Math.round(v).toLocaleString("zh-CN");

export default function AutoReplenishClient() {
  const me = useMe();
  return <AutoReplenishWorkspace key={`${me?.id}:${me?.roles.join(",")}`} me={me} />;
}

function AutoReplenishWorkspace({ me }: { me: Me | null }) {
  const { message } = App.useApp();
  const [data, setData] = useState<AutoData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Candidate[]>([]);
  const [drafting, setDrafting] = useState(false);

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    setLoadError(null);
    try {
      const latestReadResult = await fetchJson<AutoData>("/api/report/auto-replenish", { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setData(latestReadResult);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      setLoadError((e as Error).message);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead]);
  const recovery = useBhCreateRecovery(me?.id ?? null, hasAnyRole(me, "ops", "pmc"), () => void load());
  useEffect(() => { void load(); }, [load]);

  const bulkDraft = async () => {
    const usable = selected.filter((r) => r.suggestQty != null);
    if (usable.length === 0) { message.info("请先勾选候选行"); return; }
    // E1-03：服务端上限 200 项。超限显式告知并要求分批，绝不静默截断。
    if (usable.length > DRAFT_MAX) {
      message.warning(`一次最多 ${DRAFT_MAX} 项（当前已选 ${usable.length}）——请分批生成，避免草稿被截断。`);
      return;
    }
    const items = usable.map((r) => ({ skuId: r.skuId, qty: r.suggestQty as string }));
    setDrafting(true);
    try {
      const res = await recovery.submit({
        source: "replenish", lines: items,
        remark: "由自动补货候选（守护式）批量生成——人工确认，仍走审批",
      });
      if (!res?.document) return;
      message.success(`已确认原备货申请 ${res.document.docNo}，请核对当前状态`);
      setSelected([]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  const commonCols: ColumnsType<Candidate> = [
    { title: "分层", dataIndex: "cell", width: 80, render: (v: string) => cellTag(v) },
    { title: "SKU 编码", dataIndex: "code", width: 155, render: (v: string) => skuLink(v) },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    { title: "品牌", dataIndex: "brand", width: 100, render: (v: string | null) => v ?? "—" },
    { title: "可销天数", dataIndex: "daysCover", width: 95, align: "right", render: coverRender },
    { title: "生产周期", dataIndex: "leadDays", width: 90, align: "right", render: (v: number | null) => (v == null ? "—" : `${v} 天`) },
    {
      title: "建议量",
      dataIndex: "suggestQty",
      width: 130,
      align: "right",
      render: (v: string | null, r) => (v == null ? "—" : `${Number(v).toLocaleString("zh-CN")} ${r.baseUom}`),
    },
  ];

  const exceptionCols: ColumnsType<Exception> = [
    ...(commonCols as ColumnsType<Exception>),
    { title: "需人工原因", dataIndex: "reason", width: 260, render: (v: string) => <Typography.Text type="warning">{v}</Typography.Text> },
  ];

  const candidateTab = (
    <div>
      {selected.length > 0 ? (
        <div style={{ position: "sticky", top: 0, zIndex: 2, marginBottom: 8, padding: "8px 12px", background: "#e6f4ff", borderRadius: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography.Text>
            已选 {selected.length} 个候选 SKU
            {selected.filter((r) => r.suggestQty != null).length > DRAFT_MAX ? (
              <Typography.Text type="danger">（超过单张上限 {DRAFT_MAX}，请分批）</Typography.Text>
            ) : null}
          </Typography.Text>
          <Space>
            <Button size="small" onClick={() => setSelected([])}>清除</Button>
            <Popconfirm
              title={`将为所选 ${selected.length} 个候选 SKU 生成 1 张备货申请草稿（不自动提交，仍走审批）？`}
              onConfirm={() => void bulkDraft()}
            >
              <Button
                size="small"
                type="primary"
                loading={drafting}
                disabled={selected.filter((r) => r.suggestQty != null).length > DRAFT_MAX || !hasAnyRole(me, "pmc") || !recovery.ready || recovery.busy || !!recovery.request}
              >
                批量生成补货草稿
              </Button>
            </Popconfirm>
          </Space>
        </div>
      ) : null}
      <Table<Candidate>
        rowKey="skuId"
        size="small"
        columns={commonCols}
        dataSource={data?.candidates ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        rowSelection={{
          selectedRowKeys: selected.map((r) => r.skuId),
          preserveSelectedRowKeys: true,
          onChange: (_keys, rows) => setSelected(rows.filter((r) => r != null)),
        }}
        pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
      />
    </div>
  );

  const exceptionTab = (
    <Table<Exception>
      rowKey="skuId"
      size="small"
      columns={exceptionCols}
      dataSource={data?.exceptions ?? []}
      loading={loading}
      scroll={{ x: "max-content" }}
      pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
    />
  );

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>自动补货候选（守护式）</Typography.Title>
      <CaliberNote
        summary={<>守护式：仅 A/B 类·需求稳定(X/Y)·非覆盖缺口·有生产周期的告急 SKU 列为可自动；其余转人工。生成草稿仍走审批。</>}
        detail={<div><p>自动候选五门：有真实建议量、ABC ∈ A/B、XYZ ∈ X/Y（波动大不宜自动）、非覆盖缺口（防对海外仓已有库存重复下单）、生产周期在档。</p><p>批准 BH 后如需自动开工单，在 系统管理→运行参数 开启 auto_wo_on_bh（D33 自动链）。</p></div>}
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="自动补货候选" retrying={loading} />
      <BhCreateRecovery recovery={recovery} />
      <Space className="compact-stat-strip" wrap>
        <Statistic title="可自动候选数" value={data ? data.summary.candidateCount : "—"} />
        <Statistic title="需人工数" value={data ? data.summary.exceptionCount : "—"} />
        <Statistic title="候选建议总量" value={data ? Number(data.summary.totalSuggestQty).toLocaleString("zh-CN") : "—"} />
      </Space>
      <Tabs
        items={[
          { key: "auto", label: `可自动候选（${data ? data.summary.candidateCount : "—"}）`, children: candidateTab },
          { key: "manual", label: `需人工判断（${data ? data.summary.exceptionCount : "—"}）`, children: exceptionTab },
        ]}
      />
    </div>
  );
}
