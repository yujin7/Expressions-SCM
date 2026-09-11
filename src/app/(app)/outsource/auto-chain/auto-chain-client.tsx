"use client";

import { useLatestRead } from "@/components/useLatestRead";

/** D33 自动链预演（spec/11 上线闸）：先看清会生成什么，再逐步放开开关 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";

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

export default function AutoChainClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    try {
      const latestReadResult = await fetchJson<Data>("/api/outsource/auto-chain/preview", { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setData(latestReadResult);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      message.error((e as Error).message);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, message]);
  useEffect(() => { void load(); }, [load]);

  const genBatch = async (woId: number) => {
    try {
      const r = await postJson<{ docNo: string; batchSeq: number; qty: string }>("/api/outsource/auto-chain/batch", { woId });
      message.success(`已生成批次草稿 ${r.docNo}（第 ${r.batchSeq} 批，${formatQty(r.qty)}）——请到加工通知单审批`);
      void load();
    } catch (e) { message.error((e as Error).message); }
  };
  const genWo = async (bhId: number, skuId: number) => {
    try {
      const r = await postJson<{ docNo: string }>("/api/outsource/auto-chain/wo", { bhId, skuId });
      message.success(`已生成工单草稿 ${r.docNo}——请到委外工单提交审批`);
      void load();
    } catch (e) { message.error((e as Error).message); }
  };

  const batchCols: ColumnsType<Batch> = [
    { title: "工单", dataIndex: "woDocNo", width: 150 },
    { title: "成品", render: (_, r) => `${r.productCode} ${r.productName}`, ellipsis: true },
    { title: "工单量", dataIndex: "woQty", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "到料可产", dataIndex: "producible", width: 90, align: "right" },
    {
      // E2-09：「现在够不够」之外，回答业务真正要问的「几号能齐套」。
      // 视野内齐不了就直说并指出卡在哪个料，不给一个含糊的日期。
      title: "预计齐套日",
      dataIndex: "kitDate",
      width: 120,
      render: (v: string | null, r: Batch) => (
        <Tooltip title={r.kitNote + (r.kitBlockers?.length ? `；卡料：${r.kitBlockers.map((b: Batch["kitBlockers"][number]) => `#${b.materialSkuId} 缺 ${b.shortBy}`).join("、")}` : "")}>
          {v ? <span>{v}</span> : <span style={{ color: "#cf1322" }}>视野内齐不了</span>}
        </Tooltip>
      ),
    },
    {
      title: "旧台账参考",
      dataIndex: "referenceKitDate",
      width: 125,
      render: (v: string | null, r: Batch) =>
        r.referenceEvidenceCount > 0 ? (
          <Tooltip title={`${r.referenceKitNote}；其中备料池剩余 ${formatQty(r.referenceReservedQty)}`}>
            <Tag color={v ? "geekblue" : "orange"} style={{ marginInlineEnd: 0 }}>
              {v ?? "视野内未可得"}
            </Tag>
          </Tooltip>
        ) : <Typography.Text type="secondary">无匹配旁证</Typography.Text>,
    },
    { title: "已下批", dataIndex: "alreadyBatched", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "批次数", dataIndex: "existingBatches", width: 70, align: "right" },
    { title: "建议新批", dataIndex: "suggestQty", width: 100, align: "right", render: (v: number) => (v > 0 ? <Tag color="green">{v.toLocaleString("zh-CN")}</Tag> : "—") },
    {
      title: "操作", width: 130,
      render: (_, r) => r.blockedReason
        ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.blockedReason}</Typography.Text>
        : <Button size="small" type="primary" onClick={() => void genBatch(r.woId)}>生成批次草稿</Button>,
    },
  ];
  const woCols: ColumnsType<WoSug> = [
    { title: "备货申请", dataIndex: "bhDocNo", width: 150 },
    { title: "成品", dataIndex: "skuCode", width: 130 },
    { title: "数量", dataIndex: "qty", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "OEM 归属", dataIndex: "supplierName", width: 160, render: (v: string | null) => v ?? "—" },
    { title: "计划加工费", dataIndex: "feeRatePlan", width: 100, align: "right", render: (v: string | null) => v ?? "—" },
    {
      title: "操作", width: 140,
      render: (_, r) => r.blockedReason
        ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.blockedReason}</Typography.Text>
        : <Button size="small" type="primary" onClick={() => void genWo(r.bhId, r.skuId)}>生成工单草稿</Button>,
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>自动链预演（D33）</Typography.Title>
      <Alert
        style={{ marginBottom: 12 }}
        type={data?.flags.autoJgOnReady || data?.flags.autoWoOnBh ? "warning" : "info"}
        showIcon
        message={`口径：自动只产草稿，审批永远人工。开关状态：BH自动建WO=${data?.flags.autoWoOnBh ? "开" : "关"} · 齐套自动JG=${data?.flags.autoJgOnReady ? "开" : "关"}（运行参数页调整）。自动判断只使用实时账与系统 PO；旧流程包材在途/备料仅作第二条旁证，不改变可产量、建议量或阻断结果。护栏：批次≤8、待复核成品不自动、有待批草稿先处理。`}
      />
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Card size="small" title={`齐套批次建议（${data?.batches.length ?? 0}）`}>
          <Table<Batch> rowKey="woId" size="small" columns={batchCols} dataSource={data?.batches ?? []} loading={loading} pagination={false} />
        </Card>
        <Card size="small" title={`备货→工单建议（${data?.wos.length ?? 0}）`}>
          <Table<WoSug> rowKey={(r) => `${r.bhId}-${r.skuId}`} size="small" columns={woCols} dataSource={data?.wos ?? []} loading={loading} pagination={false} />
        </Card>
      </Space>
    </div>
  );
}
