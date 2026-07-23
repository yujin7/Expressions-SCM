"use client";

import { useCallback, useEffect, useState } from "react";
import {
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import RemoteSelect from "@/components/RemoteSelect";
import { fetchJson, postJson } from "@/components/fetchJson";
import { toOptions } from "@/components/labels";

interface ExceptionRow {
  id: number;
  aliasType: string;
  rawValue: string;
  context: unknown;
  status: "open" | "resolved" | "ignored";
  resolvedTargetId: number | null;
  resolvedAt: string | null;
  createdAt: string;
}

const ALIAS_TYPE_LABELS: Record<string, string> = {
  warehouse: "仓库",
  channel: "渠道",
  sku_code: "商家编码",
  sku_barcode: "条形码",
  supplier_oem: "OEM简码",
  brand: "品牌",
};

const ALIAS_TYPE_COLORS: Record<string, string> = {
  warehouse: "geekblue",
  channel: "cyan",
  sku_code: "blue",
  sku_barcode: "purple",
  supplier_oem: "orange",
  brand: "magenta",
};

const STATUS_LABELS: Record<string, string> = {
  open: "待认领",
  resolved: "已认领",
  ignored: "已忽略",
};

const STATUS_COLORS: Record<string, string> = {
  open: "warning",
  resolved: "success",
  ignored: "default",
};

const STATUS_TABS = [
  { key: "open", label: "待认领" },
  { key: "resolved", label: "已认领" },
  { key: "ignored", label: "已忽略" },
];

/** 目标主档选择器：按别名类型切换（品牌/渠道暂无管理页，填 ID） */
function TargetPicker({ aliasType }: { aliasType: string }) {
  if (aliasType === "warehouse") {
    return (
      <RemoteSelect
        api="/api/master/warehouse"
        getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
        placeholder="选择目标仓库"
      />
    );
  }
  if (aliasType === "sku_code" || aliasType === "sku_barcode") {
    return (
      <RemoteSelect
        api="/api/master/sku"
        getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
        placeholder="选择目标 SKU"
      />
    );
  }
  if (aliasType === "supplier_oem") {
    return (
      <RemoteSelect
        api="/api/master/supplier"
        getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
        placeholder="选择目标供应商"
      />
    );
  }
  return <InputNumber min={1} precision={0} placeholder="目标 ID" style={{ width: "100%" }} />;
}

function contextText(context: unknown): string {
  if (context == null) return "";
  if (typeof context === "string") return context;
  try {
    return JSON.stringify(context);
  } catch {
    return String(context);
  }
}

export default function ExceptionsClient() {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ targetId: number }>();
  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState("open");
  const [aliasType, setAliasType] = useState<string | undefined>();

  const [claiming, setClaiming] = useState<ExceptionRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [ignoreNote, setIgnoreNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (aliasType) params.set("aliasType", aliasType);
      const res = await fetchJson<{ data: ExceptionRow[]; total: number }>(
        `/api/import/exceptions?${params.toString()}`,
      );
      setRows(res.data);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status, aliasType, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 操作成功后：刷新列表 + 报告剩余待认领数量 */
  const afterAction = async (verb: string) => {
    void load();
    try {
      const res = await fetchJson<{ total: number }>(
        "/api/import/exceptions?status=open&page=1&pageSize=1",
      );
      message.success(`${verb}成功，剩余待认领 ${res.total} 条`);
    } catch {
      message.success(`${verb}成功`);
    }
  };

  const handleClaim = async () => {
    if (!claiming) return;
    try {
      const values = await form.validateFields();
      setSaving(true);
      await postJson(`/api/import/exceptions/${claiming.id}/claim`, { targetId: values.targetId });
      setClaiming(null);
      form.resetFields();
      await afterAction("认领");
    } catch (e) {
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleIgnore = async (row: ExceptionRow) => {
    try {
      const note = ignoreNote.trim();
      await postJson(`/api/import/exceptions/${row.id}/ignore`, note ? { note } : {});
      setIgnoreNote("");
      await afterAction("忽略");
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const columns: ColumnsType<ExceptionRow> = [
    {
      title: "类型",
      dataIndex: "aliasType",
      width: 110,
      render: (v: string) => (
        <Tag color={ALIAS_TYPE_COLORS[v] ?? "default"}>{ALIAS_TYPE_LABELS[v] ?? v}</Tag>
      ),
    },
    {
      title: "原始值",
      dataIndex: "rawValue",
      width: 240,
      render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
    },
    {
      title: "来源上下文",
      dataIndex: "context",
      render: (v: unknown) => {
        const text = contextText(v);
        if (!text) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Tooltip title={<div style={{ maxWidth: 480, wordBreak: "break-all" }}>{text}</div>}>
            <Typography.Text type="secondary" ellipsis style={{ maxWidth: 320, display: "inline-block" }}>
              {text}
            </Typography.Text>
          </Tooltip>
        );
      },
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 90,
      render: (v: string) => <Tag color={STATUS_COLORS[v] ?? "default"}>{STATUS_LABELS[v] ?? v}</Tag>,
    },
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 150,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
    },
    {
      title: "操作",
      key: "_actions",
      width: 140,
      render: (_, r) =>
        r.status === "open" ? (
          <Space size={0}>
            <Button
              type="link"
              size="small"
              onClick={() => {
                form.resetFields();
                setClaiming(r);
              }}
            >
              认领
            </Button>
            <Popconfirm
              title="忽略该异常？"
              description={
                <div style={{ maxWidth: 260 }}>
                  <div style={{ marginBottom: 4 }}>忽略后该原始值不再解析（歧义码/垃圾值）。</div>
                  <Input
                    placeholder="备注（可选）"
                    maxLength={200}
                    value={ignoreNote}
                    onChange={(e) => setIgnoreNote(e.target.value)}
                  />
                </div>
              }
              okText="忽略"
              cancelText="取消"
              onOpenChange={(open) => {
                if (open) setIgnoreNote("");
              }}
              onConfirm={() => void handleIgnore(r)}
            >
              <Button type="link" size="small" danger>
                忽略
              </Button>
            </Popconfirm>
          </Space>
        ) : r.status === "resolved" && r.resolvedTargetId != null ? (
          <Typography.Text type="secondary">→ #{r.resolvedTargetId}</Typography.Text>
        ) : null,
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        别名认领
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        导入时无法解析的仓库/渠道/编码等原始值在此排队，认领一次永久生效。
      </Typography.Paragraph>
      <Tabs
        activeKey={status}
        items={STATUS_TABS}
        onChange={(key) => {
          setStatus(key);
          setPage(1);
        }}
      />
      <Space style={{ marginBottom: 16, display: "flex", justifyContent: "space-between" }} wrap>
        <Select
          allowClear
          placeholder="全部类型"
          style={{ width: 160 }}
          options={toOptions(ALIAS_TYPE_LABELS)}
          value={aliasType}
          onChange={(v) => {
            setAliasType(v);
            setPage(1);
          }}
        />
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>
      <Table<ExceptionRow>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />

      <Modal
        title="认领别名"
        open={claiming != null}
        onOk={() => void handleClaim()}
        onCancel={() => setClaiming(null)}
        confirmLoading={saving}
        forceRender
        maskClosable={false}
        okText="认领"
        cancelText="取消"
      >
        {claiming ? (
          <>
            <Typography.Paragraph>
              <Tag color={ALIAS_TYPE_COLORS[claiming.aliasType] ?? "default"}>
                {ALIAS_TYPE_LABELS[claiming.aliasType] ?? claiming.aliasType}
              </Tag>
              <Typography.Text code>{claiming.rawValue}</Typography.Text>
            </Typography.Paragraph>
            <Form form={form} layout="vertical">
              <Form.Item
                name="targetId"
                label="归属目标"
                rules={[{ required: true, message: "必须指定归属目标" }]}
                help={
                  claiming.aliasType === "brand" || claiming.aliasType === "channel"
                    ? "品牌/渠道请填目标 ID（管理页建设中）"
                    : undefined
                }
              >
                <TargetPicker aliasType={claiming.aliasType} />
              </Form.Item>
            </Form>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
