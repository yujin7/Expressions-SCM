"use client";

/**
 * 检验不合格去向面板（W2 审计 3）——挂在收货检验区结果下方。
 *
 * 在此之前 `qc_lines.fail_handling` 存了 rework/scrap 就结束了：没有退货单、没有质量案件、
 * 没有扣款依据，也没有任何人被指派处理。能力藏在服务层等于不存在，所以这个入口必须在检验结果旁边。
 *
 * 面板明说两件常被误解的事：
 *  · 让步接收量**已经入库**（W2 起），所以它是唯一真正可退的量；
 *  · 不合格量从未入库，可退量为 0 时不会开一张永远批不掉的退货单——但质量案件照登记。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Checkbox, Descriptions, Modal, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";

interface OutcomeLine {
  qcLineId: number;
  skuCode: string;
  skuName: string;
  passQty: string;
  failQty: string;
  concessionQty: string;
  failHandlingLabel: string;
  returnableQty: string;
  purchaseLineIssue?: string | null;
}
interface Outcome {
  qcId: number;
  shDocNo: string;
  sourceType: string;
  qualityCaseId: number | null;
  returnCtId: number | null;
  lines: OutcomeLine[];
  totals: { pass: string; fail: string; concession: string; returnable: string };
  needsOutcome: boolean;
}

const SEVERITIES = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "critical", label: "紧急" },
];

export default function QcOutcomePanel({ shId, canWrite, onDone }: { shId: number; canWrite: boolean; onDone?: () => void }) {
  const { message } = App.useApp();
  const [data, setData] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createCase, setCreateCase] = useState(true);
  const [createReturn, setCreateReturn] = useState(false);
  const [severity, setSeverity] = useState("medium");

  const load = useCallback(async () => {
    try { setData(await fetchJson<Outcome>(`/api/matflow/sh/${shId}/qc-outcome`)); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [shId]);
  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    setSaving(true);
    try {
      const res = await fetchJson<{ qualityCaseNo: string | null; returnCtDocNo: string | null; returnSkippedReason: string | null }>(
        `/api/matflow/sh/${shId}/qc-outcome`,
        { method: "POST", body: JSON.stringify({ createCase, createReturn, caseSeverity: severity }) },
      );
      const parts = [
        res.qualityCaseNo ? `质量案件 ${res.qualityCaseNo}` : null,
        res.returnCtDocNo ? `退货草稿 ${res.returnCtDocNo}` : null,
      ].filter(Boolean);
      message.success(parts.length ? `已登记：${parts.join("、")}` : "已登记");
      if (res.returnSkippedReason) message.warning(res.returnSkippedReason);
      setOpen(false);
      await load();
      onDone?.();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <Alert type="warning" showIcon message="不合格去向加载失败" description={error} style={{ marginBottom: 16 }} />;
  if (!data) return null;
  const hasIssue = Number(data.totals.fail) > 0 || Number(data.totals.concession) > 0;
  if (!hasIssue) return null;
  const purchaseLineIssues = data.lines.flatMap(l => l.purchaseLineIssue ? [l.purchaseLineIssue] : []);

  const columns: ColumnsType<OutcomeLine> = [
    { title: "物料", key: "sku", render: (_: unknown, r) => `${r.skuCode} ${r.skuName}` },
    { title: "合格", dataIndex: "passQty", width: 100, align: "right" },
    { title: "不合格", dataIndex: "failQty", width: 100, align: "right" },
    { title: "去向", dataIndex: "failHandlingLabel", width: 100 },
    { title: "让步接收", dataIndex: "concessionQty", width: 100, align: "right" },
    { title: "可退货量", dataIndex: "returnableQty", width: 110, align: "right", render: (value, row) => row.purchaseLineIssue ? "待核对" : value },
  ];

  return (
    <Card size="small" title="不合格去向" style={{ marginBottom: 24 }}>
      {purchaseLineIssues.length > 0 && <Alert type="warning" showIcon message="采购行归属待核对，暂不能生成退货单" description={`${purchaseLineIssues.join("；")}。仍可登记质量案件。`} style={{ marginBottom: 12 }} />}
      <Alert
        type={data.needsOutcome ? "warning" : "success"}
        showIcon
        style={{ marginBottom: 12 }}
        message={data.needsOutcome
          ? "本次检验有不合格量但还没有任何后果登记——不处理的话它就只是报表里的一个比率。"
          : "本次检验的不合格量已登记后果。"}
        description={
          <Typography.Text type="secondary">
            让步接收量已入库并计入 PO 已收数，因此它是唯一真正可退的量；不合格量从未入库，
            可退量为 0 时不会开退货单（那种单审批必然失败），但质量案件照样登记，作为供应商责任与扣款依据。
          </Typography.Text>
        }
      />
      <Table<OutcomeLine> rowKey="qcLineId" size="small" columns={columns} dataSource={data.lines} pagination={false} style={{ marginBottom: 8 }} />
      <Descriptions size="small" column={3} style={{ marginBottom: 8 }}>
        <Descriptions.Item label="已登记质量案件">
          {data.qualityCaseId ? <Tag color="blue">#{data.qualityCaseId}</Tag> : "—"}
        </Descriptions.Item>
        <Descriptions.Item label="已登记退货单">
          {data.returnCtId ? <Tag color="blue">#{data.returnCtId}</Tag> : "—"}
        </Descriptions.Item>
        <Descriptions.Item label="可退货合计">{purchaseLineIssues.length ? "待核对采购行" : data.totals.returnable}</Descriptions.Item>
      </Descriptions>
      {canWrite ? (
        <Button type="primary" disabled={!data.needsOutcome} onClick={() => setOpen(true)}>
          登记不合格去向
        </Button>
      ) : null}

      <Modal
        title="登记不合格去向"
        open={open}
        onOk={() => void submit()}
        onCancel={() => setOpen(false)}
        confirmLoading={saving}
        okText="登记"
        cancelText="取消"
        okButtonProps={{ disabled: !createCase && !createReturn }}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Checkbox checked={createCase} onChange={(e) => setCreateCase(e.target.checked)}>
            建质量案件（挂到供应商，计入记分卡「质量案件」维度）
          </Checkbox>
          {createCase ? (
            <Space>
              <Typography.Text type="secondary">严重度</Typography.Text>
              <Select value={severity} onChange={setSeverity} options={SEVERITIES} style={{ width: 120 }} />
            </Space>
          ) : null}
          <Checkbox
            checked={createReturn}
            disabled={data.sourceType !== "po" || purchaseLineIssues.length > 0}
            onChange={(e) => setCreateReturn(e.target.checked)}
          >
            建采购退货（CT）草稿{data.sourceType !== "po" ? "（仅采购收货可用）" : purchaseLineIssues.length ? "（先核对采购行）" : `（可退 ${data.totals.returnable}）`}
          </Checkbox>
          <Typography.Text type="secondary">
            两者可以只选一个，但不能都不选——「登记后果」的意思就是至少有一件事真的发生。
          </Typography.Text>
        </Space>
      </Modal>
    </Card>
  );
}
