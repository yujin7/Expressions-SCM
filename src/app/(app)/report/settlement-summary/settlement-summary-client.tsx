"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, DatePicker, Space, Table, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import DocStatusTag from "@/components/DocStatusTag";
import ExportButton from "@/components/ExportButton";
import RemoteSelect from "@/components/RemoteSelect";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { hasAnyRole, useMe } from "@/components/useMe";

interface SupplierRow {
  supplierId: number;
  supplierName: string;
  jsCount: number;
  feePayable: string;
  deductionTotal: string;
  settleAmount: string;
}

interface DocRow {
  jsId: number;
  jsNo: string;
  jgNo: string;
  supplierId: number;
  supplierName: string;
  goodQty: string;
  concessionQty: string;
  spareQty: string;
  feePayable: string;
  deductionTotal: string;
  settleAmount: string;
  status: string;
  createdAt: string;
}

const STATUS_TABS = [
  { key: "", label: "全部" },
  { key: "pending", label: "待审批" },
  { key: "completed", label: "已完成" },
];

/** 金额列直加（decimal 字符串，2 位展示；仅供合计行展示） */
function sumMoney<T>(rows: readonly T[], key: keyof T): string {
  let cents = 0n;
  for (const r of rows) {
    const s = String(r[key] ?? "0");
    const m = /^(-?)(\d+)(?:\.(\d{0,2}))?/.exec(s);
    if (!m) continue;
    const v = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
    cents += m[1] === "-" ? -v : v;
  }
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export default function SettlementSummaryClient() {
  const { message } = App.useApp();
  const me = useMe();
  const canView = hasAnyRole(me, "purchasing", "pmc", "finance");

  const [bySupplier, setBySupplier] = useState<SupplierRow[]>([]);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [supplierId, setSupplierId] = useState<number | undefined>();
  const [from, setFrom] = useState<string | undefined>();
  const [to, setTo] = useState<string | undefined>();

  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (supplierId != null) params.set("supplierId", String(supplierId));
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params;
  }, [status, supplierId, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ bySupplier: SupplierRow[]; docs: DocRow[] }>(
        `/api/report/settlement-summary?${buildParams().toString()}`,
      );
      setBySupplier(res.bySupplier);
      setDocs(res.docs);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [buildParams, message]);

  useEffect(() => {
    if (me == null || !canView) return; // 无权角色不发请求（服务端仍是唯一权威，403）
    void load();
  }, [me, canView, load]);

  const supplierColumns: ColumnsType<SupplierRow> = [
    { title: "加工厂", dataIndex: "supplierName" },
    { title: "结算单数", dataIndex: "jsCount", width: 100, align: "right" },
    { title: "应付加工费", dataIndex: "feePayable", width: 130, align: "right" },
    { title: "扣款合计", dataIndex: "deductionTotal", width: 130, align: "right" },
    { title: "结算金额", dataIndex: "settleAmount", width: 130, align: "right" },
  ];

  const docColumns: ColumnsType<DocRow> = [
    { title: "结算单号", dataIndex: "jsNo", width: 150 },
    { title: "JG 单号", dataIndex: "jgNo", width: 150 },
    { title: "加工厂", dataIndex: "supplierName", width: 140 },
    { title: "合格数", dataIndex: "goodQty", width: 90, align: "right", render: (v: string) => formatQty(v) },
    { title: "让步", dataIndex: "concessionQty", width: 80, align: "right", render: (v: string) => formatQty(v) },
    { title: "备品", dataIndex: "spareQty", width: 80, align: "right", render: (v: string) => formatQty(v) },
    { title: "应付加工费", dataIndex: "feePayable", width: 110, align: "right" },
    { title: "扣款合计", dataIndex: "deductionTotal", width: 100, align: "right" },
    { title: "结算金额", dataIndex: "settleAmount", width: 110, align: "right" },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string) => <DocStatusTag status={v} /> },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      width: 150,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
  ];

  if (me != null && !canView) {
    return (
      <Alert
        type="warning"
        showIcon
        message="无权限查看结算汇总表"
        description="本报表含金额（R9），仅采购/生产计划/财务/管理员可见。"
      />
    );
  }

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        结算汇总表
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        口径：待审批+已完成的委外结算单（JS）；金额为开单时按 R5 固化的落库值。
      </Typography.Paragraph>
      <Tabs activeKey={status} items={STATUS_TABS} onChange={setStatus} />
      <Space style={{ marginBottom: 16, display: "flex", justifyContent: "space-between" }} wrap>
        <Space wrap>
          <DatePicker.RangePicker
            allowClear
            onChange={(values) => {
              setFrom(values?.[0] ? values[0].format("YYYY-MM-DD") : undefined);
              setTo(values?.[1] ? values[1].format("YYYY-MM-DD") : undefined);
            }}
          />
          <RemoteSelect
            api="/api/master/supplier"
            getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
            allowClear
            placeholder="全部加工厂"
            style={{ width: 240 }}
            value={supplierId}
            onChange={(v) => setSupplierId(v as number | undefined)}
          />
        </Space>
        <Space>
          <ExportButton href={`/api/export/settlement-summary?${buildParams().toString()}`} />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
      </Space>

      <Typography.Title level={5}>按加工厂汇总</Typography.Title>
      <Table<SupplierRow>
        rowKey="supplierId"
        size="small"
        columns={supplierColumns}
        dataSource={bySupplier}
        loading={loading}
        pagination={false}
        style={{ marginBottom: 24 }}
        summary={() =>
          bySupplier.length > 0 ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>
                <Typography.Text strong>合计</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <Typography.Text strong>
                  {bySupplier.reduce((acc, r) => acc + r.jsCount, 0)}
                </Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right">
                <Typography.Text strong>{sumMoney(bySupplier, "feePayable")}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right">
                <Typography.Text strong>{sumMoney(bySupplier, "deductionTotal")}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">
                <Typography.Text strong>{sumMoney(bySupplier, "settleAmount")}</Typography.Text>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          ) : null
        }
      />

      <Typography.Title level={5}>结算单明细</Typography.Title>
      <Table<DocRow>
        rowKey="jsId"
        size="middle"
        columns={docColumns}
        dataSource={docs}
        loading={loading}
        scroll={{ x: 1250 }}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
      />
    </div>
  );
}
