"use client";

/** #13 供应商确认页（公开，凭 token 打开）——展示单据摘要、逐行确认交期。无需登录。 */
import { useEffect, useState } from "react";
import { Alert, App, Button, Card, DatePicker, Descriptions, Input, Result, Table, Typography } from "antd";
import type { Dayjs } from "dayjs";

interface Line { poLineId: number; skuCode: string; skuName: string; qty: string; uom: string; expectedDate: string | null }
interface PoView {
  docNo: string; supplierName: string | null; status: string;
  expectedDate: string | null; confirmedAt: string | null; confirmNote: string | null;
  lines: Line[];
}

export default function SupplierConfirmClient({ token }: { token: string }) {
  const { message } = App.useApp();
  const [data, setData] = useState<PoView | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // 逐行交期：poLineId -> Dayjs
  const [lineDates, setLineDates] = useState<Record<number, Dayjs | null>>({});
  const [date, setDate] = useState<Dayjs | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`/api/public/po-confirm/${token}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "链接无效");
        return d as PoView;
      })
      .then(setData)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [token]);

  const submit = async () => {
    // 收集供应商填写的逐行交期
    const filled = Object.entries(lineDates)
      .filter(([, v]) => v != null)
      .map(([k, v]) => ({ poLineId: Number(k), expectedDate: (v as Dayjs).format("YYYY-MM-DD") }));
    // 表头兜底日期：优先逐行最早，否则用统一日期
    let headerDate: string | null = null;
    if (filled.length > 0) {
      headerDate = filled.map((l) => l.expectedDate).sort()[0];
    } else if (date) {
      headerDate = date.format("YYYY-MM-DD");
    }
    if (!headerDate) { message.warning("请至少填写一个交货日期"); return; }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/public/po-confirm/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedDate: headerDate,
          note: note || undefined,
          ...(filled.length > 0 ? { lines: filled } : {}),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "提交失败");
      setDone(true);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div style={{ maxWidth: 720, margin: "40px auto", padding: 16 }}>加载中…</div>;
  if (err) return <div style={{ maxWidth: 720, margin: "40px auto", padding: 16 }}><Result status="404" title="链接无效或已失效" subTitle={err} /></div>;
  if (done) return <div style={{ maxWidth: 720, margin: "40px auto", padding: 16 }}><Result status="success" title="确认已提交" subTitle={`采购单 ${data?.docNo} 交期已回传，感谢！`} /></div>;

  return (
    <div style={{ maxWidth: 720, margin: "24px auto", padding: 16 }}>
      <Typography.Title level={3}>采购单交期确认</Typography.Title>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="采购单号">{data?.docNo}</Descriptions.Item>
          <Descriptions.Item label="供应商">{data?.supplierName ?? "—"}</Descriptions.Item>
          {data?.confirmedAt ? <Descriptions.Item label="已确认交期">{data.expectedDate}（{new Date(data.confirmedAt).toLocaleDateString("zh-CN")}）</Descriptions.Item> : null}
        </Descriptions>
      </Card>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="请为每一行填写贵司可承诺的交货日期后提交；未逐行填写的可用下方统一交期兜底。如需备注请填写。" />
      <Table<Line>
        rowKey={(r) => r.poLineId}
        size="small"
        pagination={false}
        style={{ marginBottom: 16 }}
        dataSource={data?.lines ?? []}
        columns={[
          { title: "货品编码", dataIndex: "skuCode", width: 120 },
          { title: "名称", dataIndex: "skuName", ellipsis: true },
          { title: "数量", dataIndex: "qty", align: "right", width: 90 },
          { title: "单位", dataIndex: "uom", width: 60 },
          {
            title: "确认交期",
            width: 160,
            render: (_: unknown, r: Line) => (
              <DatePicker
                size="small"
                value={lineDates[r.poLineId] ?? null}
                onChange={(v) => setLineDates((prev) => ({ ...prev, [r.poLineId]: v }))}
                placeholder="交货日期"
                style={{ width: 140 }}
              />
            ),
          },
        ]}
      />
      <Card size="small" title="统一交货日期（兜底，可选）">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <DatePicker value={date} onChange={setDate} placeholder="统一交货日期" />
          <Input placeholder="备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 300 }} maxLength={300} />
          <Button type="primary" loading={submitting} onClick={() => void submit()}>提交确认</Button>
        </div>
      </Card>
    </div>
  );
}
