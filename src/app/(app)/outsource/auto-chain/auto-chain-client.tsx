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

interface Batch {
  woId: number; woDocNo: string; productCode: string; productName: string; woQty: string;
  producible: number; alreadyBatched: string; existingBatches: number; suggestQty: number; blockedReason: string | null;
  kitDate: string | null; kitNote: string;
  kitBlockers: { materialSkuId: number; shortBy: string; readyDate: string | null }[];
  referenceKitDate: string | null;
  referenceKitNote: string;
  referenceEvidenceCount: number;
  referenceReservedQty: string;
}
interface WoSug {
  bhId: number; bhDocNo: string; skuId: number; skuCode: string; qty: string;
  supplierName: string | null; feeRatePlan: string | null; blockedReason: string | null;
}
interface Data { batches: Batch[]; wos: WoSug[]; flags: { autoWoOnBh: boolean; autoJgOnReady: boolean } }
interface Receipt { source: string; docNo: string; href: string }

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
  const [evidence, setEvidence] = useState<Batch | null>(null);
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
    const source = batch ? row.woDocNo : `${row.bhDocNo} / ${row.skuCode}`;
    setBusy(batch ? `batch:${row.woId}` : `wo:${row.bhId}:${row.skuId}`);
    setWriteError(null);
    setReceipt(null);
    try {
      const result = await postJson<{ id: number; docNo: string }>(`/api/outsource/auto-chain/${kind}`,
        batch ? { woId: row.woId } : { bhId: row.bhId, skuId: row.skuId });
      if (!result || !Number.isSafeInteger(result.id) || result.id <= 0 || typeof result.docNo !== "string" || !result.docNo.trim()) {
        throw new Error("未收到完整生成凭据；操作可能已完成，请先核对单据，勿重复生成");
      }
      if (!mounted.current) return;
      setReceipt({ source, docNo: result.docNo, href: `/outsource/${batch ? "jg" : "wo"}?docId=${result.id}` });
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
    { title: "到料可产", dataIndex: "producible", width: 100, align: "right", render: (v: number) => formatQty(v) },
    {
      // E2-09：「现在够不够」之外，回答业务真正要问的「几号能齐套」。
      // 视野内齐不了就直说并指出卡在哪个料，不给一个含糊的日期。
      title: "预计齐套日",
      dataIndex: "kitDate",
      width: 120,
      render: (v: string | null, r: Batch) => (
        <Button type="link" size="small" style={{ paddingInline: 0 }} aria-label={`查看 ${r.woDocNo} 齐套依据`} onClick={() => setEvidence(r)}>
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
          <Button type="link" size="small" style={{ paddingInline: 0 }} aria-label={`查看 ${r.woDocNo} 旧台账旁证`} onClick={() => setEvidence(r)}>{v ?? "视野内未可得"}</Button>
        ) : <Typography.Text type="secondary">无匹配旁证</Typography.Text>,
    },
    { title: "已下批", dataIndex: "alreadyBatched", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "批次数", dataIndex: "existingBatches", width: 70, align: "right" },
    { title: "建议新批", dataIndex: "suggestQty", width: 100, align: "right", render: (v: number) => (v > 0 ? <Tag color="green">{v.toLocaleString("zh-CN")}</Tag> : "—") },
    {
      title: "操作", width: 160,
      render: (_, r) => r.blockedReason
        ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.blockedReason}</Typography.Text>
        : <Button size="small" type="primary" loading={busy === `batch:${r.woId}`} disabled={disabled} onClick={() => void generate("batch", r)}>生成批次草稿</Button>,
    },
  ];
  const woCols: ColumnsType<WoSug> = [
    { title: "备货申请", dataIndex: "bhDocNo", width: 170, render: (v: string, r) => <Link href={`/outsource/bh?docId=${r.bhId}`}>{v}</Link> },
    { title: "成品", dataIndex: "skuCode", width: 130 },
    { title: "数量", dataIndex: "qty", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "OEM 归属", dataIndex: "supplierName", width: 160, render: (v: string | null) => v ?? "—" },
    { title: "计划加工费", dataIndex: "feeRatePlan", width: 100, align: "right", render: (v: string | null) => v ?? "—" },
    {
      title: "操作", width: 140,
      render: (_, r) => r.blockedReason
        ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.blockedReason}</Typography.Text>
        : <Button size="small" type="primary" loading={busy === `wo:${r.bhId}:${r.skuId}`} disabled={disabled} onClick={() => void generate("wo", r)}>生成工单草稿</Button>,
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
        description={<><div>BH 自动建 WO：{data ? (data.flags.autoWoOnBh ? "开" : "关") : "未知"} · 齐套自动 JG：{data ? (data.flags.autoJgOnReady ? "开" : "关") : "未知"}（运行参数页调整）。</div><div>到料可产与建议量按系统 PO 到料计算；预计齐套日为系统供给预测。旧台账仅作旁证，不改变生成资格。批次≤8、待复核成品不自动、有待批草稿先处理。</div></>}
      />
      <ListToolbar state={list} extra={<SearchInput aria-label="筛选自动链建议" placeholder="工单 / 备货单 / 成品 / OEM" value={searchDraft} onChange={e => setSearchDraft(e.target.value)} onSearch={value => list.setFilter({ q: value.trim() })} allowClear style={{ width: 300, maxWidth: "100%" }} />}
        primaryActions={<Button onClick={refresh} loading={loading} disabled={busy !== null}>刷新预演</Button>} />
      <Space direction="vertical" size={12} style={{ width: "100%", minWidth: 0 }}>
        <LoadErrorAlert subject="自动链预演" error={loadError} onRetry={refresh} retrying={loading} />
        {writeError ? <Alert type="error" showIcon message="本次生成未获成功确认" description={<>{writeError}<div>先刷新预演并核对来源单据；刷新只读取，不会再次生成。</div></>} action={<Button size="small" onClick={refresh} disabled={busy !== null} loading={loading}>刷新核对</Button>} /> : null}
        {receipt ? <Alert type="success" showIcon message={`已生成草稿 ${receipt.docNo}`} description={<><div>来源：{receipt.source}。本次仅创建，尚未提交审批。</div><Link href={receipt.href}>打开 {receipt.docNo} · 检查并提交</Link></>} /> : null}
        <Card size="small" title={`齐套批次建议（${count(batches.length, data?.batches.length)}）`}>
          <Table<Batch> rowKey="woId" size={list.tableSize} tableLayout="fixed" scroll={{ x: 1265 }} columns={batchCols} dataSource={batches} loading={loading} pagination={false} locale={{ emptyText: data ? (needle ? "没有匹配的批次建议，请调整或清空筛选" : "当前没有齐套批次建议") : "尚未取得预演数据" }} />
        </Card>
        <Card size="small" title={`备货→工单建议（${count(wos.length, data?.wos.length)}）`}>
          <Table<WoSug> rowKey={(r) => `${r.bhId}-${r.skuId}`} size={list.tableSize} tableLayout="fixed" scroll={{ x: 790 }} columns={woCols} dataSource={wos} loading={loading} pagination={false} locale={{ emptyText: data ? (needle ? "没有匹配的工单建议，请调整或清空筛选" : "当前没有备货转工单建议") : "尚未取得预演数据" }} />
        </Card>
      </Space>
      <Modal title={evidence ? `${evidence.woDocNo} · 齐套依据` : "齐套依据"} open={evidence !== null} onCancel={() => setEvidence(null)} footer={<Button onClick={() => setEvidence(null)}>关闭依据</Button>}>
        {evidence ? <>
          <Typography.Paragraph>{evidence.productCode} · {evidence.productName || "名称未补录"}</Typography.Paragraph>
          <Typography.Title level={5}>系统供给预测</Typography.Title>
          <Typography.Paragraph>{evidence.kitNote}</Typography.Paragraph>
          {evidence.kitBlockers.length ? <ul>{evidence.kitBlockers.map(b => <li key={b.materialSkuId}>物料 #{b.materialSkuId}：缺 {formatQty(b.shortBy)}；{b.readyDate ? `预计 ${b.readyDate}` : "视野内无可用日期"}</li>)}</ul> : null}
          <Typography.Title level={5}>旧台账旁证 · 不参与生成数量</Typography.Title>
          <Typography.Paragraph>{evidence.referenceEvidenceCount ? `${evidence.referenceKitNote}；备料池剩余 ${formatQty(evidence.referenceReservedQty)}` : "无匹配旁证，不能推断为库存为零。"}</Typography.Paragraph>
        </> : null}
      </Modal>
    </div>
  );
}
