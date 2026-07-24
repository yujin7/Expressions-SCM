"use client";

/** #13 供应商确认页（公开，凭 token 打开）——展示单据摘要、提交确认交期。无需登录。 */
import { useEffect, useState } from "react";
import { Alert, App, Button, Card, DatePicker, Descriptions, Input, Result, Table, Typography } from "antd";
import type { Dayjs } from "dayjs";

interface Line { skuCode: string; skuName: string; qty: string; uom: string }
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
    if (!date) { message.warning("请选择交货日期"); return; }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/public/po-confirm/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedDate: date.format("YYYY-MM-DD"), note: note || undefined }),
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
      <Table<Line>
        rowKey={(r) => r.skuCode}
        size="small"
        pagination={false}
        style={{ marginBottom: 16 }}
        dataSource={data?.lines ?? []}
        columns={[
          { title: "货品编码", dataIndex: "skuCode", width: 130 },
          { title: "名称", dataIndex: "skuName", ellipsis: true },
          { title: "数量", dataIndex: "qty", align: "right", width: 100 },
          { title: "单位", dataIndex: "uom", width: 70 },
        ]}
      />
      <Card size="small" title="确认交货日期">
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="请填写贵司可承诺的交货日期后提交；如需备注请填写。" />
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <DatePicker value={date} onChange={setDate} placeholder="选择交货日期" />
          <Input placeholder="备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 300 }} maxLength={300} />
          <Button type="primary" loading={submitting} onClick={() => void submit()}>提交确认</Button>
        </div>
      </Card>
    </div>
  );
}
