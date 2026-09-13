"use client";

/** D33 自动链预演（spec/11 上线闸）：先看清会生成什么，再逐步放开开关 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert, Button, Card, Modal, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { useDocumentRead } from "@/components/useDocumentRead";
import { useListState } from "@/components/useListState";
import ListToolbar from "@/components/ListToolbar";
import SearchInput from "@/components/SearchInput";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import KitFactoryEvidence from "@/components/KitFactoryEvidence";
import type { BatchSuggestion } from "@/server/modules/outsource/auto-chain";

interface Batch {
  woId: number; woDocNo: string; productCode: string; productName: string; woQty: string;
  producible: string; alreadyBatched: string; existingBatches: number; suggestQty: string; blockedReason: string | null;
  kitDate: string | null; kitNote: string;
  kitBlockers: { materialSkuId: number; shortBy: string; readyDate: string | null }[];
  kitBasis?: BatchSuggestion["kitBasis"];
  kitSnapshotDate?: string | null;
  referenceKitDate: string | null;
  referenceKitNote: string;
  referenceEvidenceCount: number;
  referenceReservedQty: string;
}
interface WoSug {
  bhId: number; bhLineId: number; bhDocNo: string; skuId: number; skuCode: string; qty: string;
  supplierName: string | null; feeRatePlan: string | null; blockedReason: string | null;
  expectDate: string | null;
  generated: { id: number; docNo: string; status: string } | null;
  legacyDocuments: { id: number; docNo: string }[];
}
interface Data { batches: Batch[]; wos: WoSug[]; flags: { autoWoOnBh: boolean; autoJgOnReady: boolean } }
interface Receipt { source: string; docNo: string; href: string; recovered: boolean }

function validPreview(value: Data | null): value is Data {
  return !!value && Array.isArray(value.batches) && Array.isArray(value.wos)
    && typeof value.flags?.autoWoOnBh === "boolean" && typeof value.flags?.autoJgOnReady === "boolean";
}

export default function AutoChainClient() {
  const read = useDocumentRead<Data>("/api/outsource/auto-chain/preview");
  const data = validPreview(read.data) ? read.data : null;
  const loading = read.phase === "loading";
  const loadError = read.error ?? (read.phase === "success" && !data ? "预演数据不完整，请刷新核对" : null);
  const list = useListState({ key: "auto-chain", defaults: { q: "" }, paginated: false, defaultDensity: "small" });
  const q = list.filters.q ?? "";
  const [searchDraft, setSearchDraft] = useState(q);
  useEffect(() => { setSearchDraft(q); }, [q]);
  const [evidence, setEvidence] = useState<(Batch & { readKey: number }) | null>(null);
  const evidenceSequence = useRef(0);
  const openEvidence = (row: Batch) => setEvidence({ ...row, readKey: ++evidenceSequence.current });
  const [busy, setBusy] = useState<string | null>(null);
  const writing = useRef(false);
  const mounted = useRef(true);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refresh = () => {
    if (writing.current) return;
    setEvidence(null);
    setNeedsRefresh(false);
    read.retry();
  };
  const generate = async (kind: "batch" | "wo", row: Batch | WoSug) => {
    // Synchronous guard also covers two clicks before React paints the loading state.
    if (writing.current || !data || loading || loadError || needsRefresh || row.blockedReason) return;
    writing.current = true;
    const batch = "woId" in row;
    const source = batch ? row.woDocNo : `${row.bhDocNo} 明细#${row.bhLineId} / ${row.skuCode}`;
    setBusy(batch ? `batch:${row.woId}` : `wo:${row.bhLineId}`);
    setWriteError(null);
    setReceipt(null);
    try {
      const result = await postJson<{ id: number; docNo: string; idempotent?: boolean }>(`/api/outsource/auto-chain/${kind}`,
        batch ? { woId: row.woId } : { bhId: row.bhId, bhLineId: row.bhLineId, skuId: row.skuId });
      if (!result || !Number.isSafeInteger(result.id) || result.id <= 0 || typeof result.docNo !== "string" || !result.docNo.trim()) {
        throw new Error("未收到完整生成凭据；操作可能已完成，请先核对单据，勿重复生成");
      }
      if (!mounted.current) return;
      setReceipt({ source, docNo: result.docNo, href: `/outsource/${batch ? "jg" : "wo"}?docId=${result.id}`, recovered: result.idempotent === true });
      setEvidence(null);
      read.retry();
    } catch (error) {
      if (!mounted.current) return;
      setWriteError(`${source}：${error instanceof Error ? error.message : "生成失败，请先核对结果"}`);
      setNeedsRefresh(true);
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const disabled = busy !== null || loading || !data || needsRefresh;
  const needle = q.trim().toLocaleLowerCase();
  const matches = (...values: (string | null)[]) => !needle || values.some(v => v?.toLocaleLowerCase().includes(needle));
  const batches = data?.batches.filter(r => matches(r.woDocNo, r.productCode, r.productName)) ?? [];
  const wos = data?.wos.filter(r => matches(r.bhDocNo, r.skuCode, r.supplierName)) ?? [];
  const count = (filtered: number, total?: number) => total === undefined ? (loading ? "加载中" : "未知") : needle ? `${filtered} / ${total}` : String(total);

  const batchCols: ColumnsType<Batch> = [
    { title: "工单", dataIndex: "woDocNo", width: 170, render: (v: string, r) => <Link href={`/outsource/wo?docId=${r.woId}`}>{v}</Link> },
    { title: "成品", key: "product", width: 240, render: (_, r) => <div style={{ overflowWrap: "anywhere" }}><Typography.Text>{r.productCode}</Typography.Text><div>{r.productName || "名称未补录"}</div></div> },
    { title: "工单量", dataIndex: "woQty", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "采购已收折算", dataIndex: "producible", width: 100, align: "right", render: (v: string) => <span style={{ overflowWrap: "anywhere" }}>{formatQty(v)}</span> },
    {
      // E2-09：「现在够不够」之外，回答业务真正要问的「几号能齐套」。
      // 视野内齐不了就直说并指出卡在哪个料，不给一个含糊的日期。
      title: "预计齐套日",
      dataIndex: "kitDate",
      width: 120,
      render: (v: string | null, r: Batch) => (
        <Button type="link" size="small" style={{ paddingInline: 0 }} aria-label={`查看 ${r.woDocNo} 齐套依据`} onClick={() => openEvidence(r)}>
          {v ?? "视野内齐不了"}
        </Button>
      ),
    },
    {
      title: "旧台账参考",
      dataIndex: "referenceKitDate",
      width: 125,
      render: (v: string | null, r: Batch) =>
        r.referenceEvidenceCount > 0 ? (
          <Button type="link" size="small" style={{ paddingInline: 0 }} aria-label={`查看 ${r.woDocNo} 旧台账旁证`} onClick={() => openEvidence(r)}>{v ?? "视野内未可得"}</Button>
        ) : <Typography.Text type="secondary">无匹配旁证</Typography.Text>,
    },
    { title: "已下批", dataIndex: "alreadyBatched", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "批次数", dataIndex: "existingBatches", width: 70, align: "right" },
    { title: "建议新批", dataIndex: "suggestQty", width: 100, align: "right", render: (v: string) => (formatQty(v) !== "0" ? <Tag color="green">{formatQty(v)}</Tag> : "—") },
    {
      title: "操作", width: 160,
      render: (_, r) => r.blockedReason
        ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.blockedReason}</Typography.Text>
        : <Button size="small" type="primary" loading={busy === `batch:${r.woId}`} disabled={disabled} onClick={() => void generate("batch", r)}>生成批次草稿</Button>,
    },
  ];
  const woCols: ColumnsType<WoSug> = [
    { title: "备货申请", dataIndex: "bhDocNo", width: 170, render: (v: string, r) => <><Link href={`/outsource/bh?docId=${r.bhId}`}>{v}</Link><div style={{ fontSize: 12 }}>明细 #{r.bhLineId} · 期望 {r.expectDate ?? "未填"}</div></> },
    { title: "成品", dataIndex: "skuCode", width: 170, render: (v: string) => <span style={{ overflowWrap: "anywhere" }}>{v}</span> },
    { title: "数量", dataIndex: "qty", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "OEM 归属", dataIndex: "supplierName", width: 160, render: (v: string | null) => v ?? "—" },
    { title: "计划加工费", dataIndex: "feeRatePlan", width: 100, align: "right", render: (v: string | null) => v ?? "—" },
    {
      title: "操作", width: 140,
      render: (_, r) => r.generated
        ? <Link href={`/outsource/wo?docId=${r.generated.id}`}>打开已生成工单 {r.generated.docNo}</Link>
        : r.blockedReason
          ? <><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.blockedReason}</Typography.Text>{r.legacyDocuments?.map(doc => <div key={doc.id}><Link href={`/outsource/wo?docId=${doc.id}`}>核对 {doc.docNo}</Link></div>)}</>
          : <Button size="small" type="primary" loading={busy === `wo:${r.bhLineId}`} disabled={disabled} onClick={() => void generate("wo", r)}>生成工单草稿</Button>,
    },
  ];

  return (
    <div style={{ minWidth: 0 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>自动链预演（D33）</Typography.Title>
      <Alert
        style={{ marginBottom: 12 }}
        type={data?.flags.autoJgOnReady || data?.flags.autoWoOnBh ? "warning" : "info"}
        showIcon
        message="只生成草稿，提交与审批仍由人工完成"
        description={<><div>BH 自动建 WO：{data ? (data.flags.autoWoOnBh ? "开" : "关") : "未知"} · 齐套自动 JG：{data ? (data.flags.autoJgOnReady ? "开" : "关") : "未知"}（运行参数页调整）。</div><div>采购已收折算按本工单 PO 已收计算，不等于实际到厂或生产放行。预计齐套日按全网在库与系统单据推演，未扣其他工单占用；点击日期核对逐料依据。旧台账不改变生成数量。暂停工单不建批，批次≤8、已有待审草稿先处理。</div></>}
      />
      <ListToolbar state={list} extra={<SearchInput aria-label="筛选自动链建议" placeholder="工单 / 备货单 / 成品 / OEM" value={searchDraft} onChange={e => setSearchDraft(e.target.value)} onSearch={value => list.setFilter({ q: value.trim() })} allowClear style={{ width: 300, maxWidth: "100%" }} />}
        primaryActions={<><a href="/matflow/sh?batchCheckPending=1">采购建批待核对</a><Button onClick={refresh} loading={loading} disabled={busy !== null}>刷新预演</Button></>} />
      <Space direction="vertical" size={12} style={{ width: "100%", minWidth: 0 }}>
        <LoadErrorAlert subject="自动链预演" error={loadError} onRetry={refresh} retrying={loading} />
        {writeError ? <Alert type="error" showIcon message="本次生成未获成功确认" description={<>{writeError}<div>先刷新预演并核对来源单据；刷新只读取，不会再次生成。</div></>} action={<Button size="small" onClick={refresh} disabled={busy !== null} loading={loading}>刷新核对</Button>} /> : null}
        {receipt ? <Alert type="success" showIcon message={`${receipt.recovered ? "已找回原工单" : "已生成草稿"} ${receipt.docNo}`} description={<><div>来源：{receipt.source}。{receipt.recovered ? "没有重复创建；请打开核对当前状态。" : "本次仅创建，尚未提交审批。"}</div><Link href={receipt.href}>打开 {receipt.docNo} · {receipt.recovered ? "核对当前状态" : "检查并提交"}</Link></>} /> : null}
        <Card size="small" title={`齐套批次建议（${count(batches.length, data?.batches.length)}）`}>
          <Table<Batch> rowKey="woId" size={list.tableSize} tableLayout="fixed" scroll={{ x: 1265 }} columns={batchCols} dataSource={batches} loading={loading} pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: data ? (needle ? "没有匹配的批次建议，请调整或清空筛选" : "当前没有带物料需求的已审批或执行中工单") : "尚未取得预演数据" }} />
        </Card>
        <Card size="small" title={`备货→工单建议（${count(wos.length, data?.wos.length)}）`}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>仅展示当前账号可见备货申请的建议；沿用备货列表的本人／共享渠道范围，无范围限制的账号按既有权限查看。未列出不等于申请不存在。</Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>每条原始明细分别生成，不按同成品合并。已生成行保留原单入口；网络中断或换设备后刷新即可找回。旧工单没有明细凭据时先核对，不自动分配。</Typography.Paragraph>
          <Table<WoSug> rowKey="bhLineId" size={list.tableSize} tableLayout="fixed" scroll={{ x: 830 }} columns={woCols} dataSource={wos} loading={loading} pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: data ? (needle ? "可见范围内没有匹配的工单建议，请调整或清空筛选" : "当前可见备货申请中没有转工单建议") : "尚未取得预演数据" }} />
        </Card>
      </Space>
      <Modal destroyOnHidden width={1080} style={{ top: 24 }} styles={{ body: { maxHeight: "calc(100dvh - 180px)", overflowY: "auto" } }} title={evidence ? `${evidence.woDocNo} · 齐套依据` : "齐套依据"} open={evidence !== null} onCancel={() => setEvidence(null)} footer={<Button onClick={() => setEvidence(null)}>关闭依据</Button>}>
        {evidence ? <>
          <Typography.Paragraph>{evidence.productCode} · {evidence.productName || "名称未补录"}</Typography.Paragraph>
          <Typography.Title level={5}>系统供给预测</Typography.Title>
          <Typography.Paragraph>{evidence.kitNote}</Typography.Paragraph>
          <Alert type="warning" showIcon message="预测不等于本工单可领用或生产放行" description="全网在库含各仓实时账及最新快照，未按加工厂、批次质量或其他工单占用分配。PO已收用于现行批次建议，不能再与全网在库相加。无交期供给不进日期推演；逾期未到供给仍按原规则并入今天，须催交复核。" style={{ marginBottom: 12 }} />
          <Typography.Paragraph type="secondary">全部 {evidence.kitBasis?.length ?? "未知"} 种物料 · 数量均为各行基础单位 · 有日期未结量含视野外，日期与缺口按90天推演 · 快照最新日期：{evidence.kitSnapshotDate ?? "无快照参与"}</Typography.Paragraph>
          {evidence.kitBasis ? <Table<BatchSuggestion["kitBasis"][number]> aria-label="逐料齐套依据" rowKey="materialSkuId" size="small" tableLayout="fixed" scroll={{ x: 1080 }} dataSource={evidence.kitBasis} pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }} columns={[
            { title: "物料 / 查采购", key: "material", width: 200, render: (_, row) => <div><Link href={`/outsource/po?q=${encodeURIComponent(row.materialCode)}`}>{row.materialCode}</Link><div style={{ overflowWrap: "anywhere" }}>{row.materialName || "名称未补录"}</div></div> },
            { title: "单位", dataIndex: "baseUom", width: 60 },
            { title: "全单毛需求", dataIndex: "required", width: 100, align: "right", render: formatQty },
            { title: "本单PO已收", dataIndex: "poReceived", width: 100, align: "right", render: formatQty },
            { title: "全网在库", dataIndex: "networkOnHand", width: 95, align: "right", render: formatQty },
            { title: "有日期未结", dataIndex: "datedSupply", width: 100, align: "right", render: formatQty },
            { title: "无交期未结", dataIndex: "undatedSupply", width: 100, align: "right", render: formatQty },
            { title: "参考层排除", dataIndex: "excludedReference", width: 100, align: "right", render: formatQty },
            { title: "90天末缺口", dataIndex: "shortBy", width: 100, align: "right", render: formatQty },
            { title: "预测可齐日", dataIndex: "forecastDate", width: 125, render: (value: string | null) => value ?? "视野内未可得" },
          ]} /> : <Alert type="warning" message="未取得完整逐料依据，请刷新核对，不能仅按日期判断可生产。" />}
          <KitFactoryEvidence key={`${evidence.woId}:${evidence.readKey}`} woId={evidence.woId} />
          <Typography.Title level={5}>旧台账旁证 · 不参与生成数量</Typography.Title>
          <Typography.Paragraph>{evidence.referenceEvidenceCount ? `${evidence.referenceKitNote}；备料池剩余 ${formatQty(evidence.referenceReservedQty)}` : "无匹配旁证，不能推断为库存为零。"}</Typography.Paragraph>
        </> : null}
      </Modal>
    </div>
  );
}
