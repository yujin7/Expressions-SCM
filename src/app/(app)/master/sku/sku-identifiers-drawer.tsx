"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { fetchJson, patchJson, postJson } from "@/components/fetchJson";

interface SkuRef {
  id: number;
  code: string;
  name: string;
}

interface IdentifierRow {
  id: number;
  kind: "gtin" | "external" | "vendor" | "customer" | "legacy";
  value: string;
  scope: string;
  uom: string | null;
  packagingLevel: "each" | "inner" | "case" | "pallet" | "other" | null;
  isPrimary: boolean;
  active: boolean;
  note: string | null;
}

interface IdentifierForm {
  kind: IdentifierRow["kind"];
  value: string;
  scope?: string;
  uom?: string;
  packagingLevel?: NonNullable<IdentifierRow["packagingLevel"]>;
  isPrimary: boolean;
  note?: string;
}

const KIND_LABELS: Record<IdentifierRow["kind"], string> = {
  gtin: "GTIN / 商品条码",
  external: "外部系统编码",
  vendor: "供应商料号",
  customer: "客户货号",
  legacy: "历史编码",
};

const LEVEL_LABELS: Record<NonNullable<IdentifierRow["packagingLevel"]>, string> = {
  each: "单品",
  inner: "内包",
  case: "箱",
  pallet: "托盘",
  other: "其他",
};

export default function SkuIdentifiersDrawer({
  sku,
  canWrite,
  onClose,
}: {
  sku: SkuRef | null;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<IdentifierForm>();
  const [rows, setRows] = useState<IdentifierRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const kind = Form.useWatch("kind", form);
  const skuId = sku?.id ?? null;

  const load = useCallback(async () => {
    if (skuId == null) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      setRows(await fetchJson<IdentifierRow[]>(`/api/master/sku/${skuId}/identifiers`));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message, skuId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({ kind: "gtin", scope: "GS1", isPrimary: true });
    setCreateOpen(true);
  };

  const create = async () => {
    if (skuId == null) return;
    setSaving(true);
    try {
      const value = await form.validateFields();
      await postJson(`/api/master/sku/${skuId}/identifiers`, value);
      message.success("标识已登记");
      setCreateOpen(false);
      await load();
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = (row: IdentifierRow) => {
    if (skuId == null) return;
    modal.confirm({
      title: row.active ? "停用这个标识？" : "重新启用这个标识？",
      content: row.active
        ? "历史记录会保留；停用后不再作为有效交换标识。"
        : "重新启用不会自动设为主标识。",
      okText: row.active ? "停用" : "启用",
      okButtonProps: row.active ? { danger: true } : undefined,
      cancelText: "取消",
      onOk: async () => {
        try {
          await patchJson(`/api/master/sku/${skuId}/identifiers`, {
            identifierId: row.id,
            active: !row.active,
          });
          message.success(row.active ? "标识已停用" : "标识已启用");
          await load();
        } catch (error) {
          message.error((error as Error).message);
          throw error;
        }
      },
    });
  };

  const promotePrimary = async (row: IdentifierRow) => {
    if (skuId == null) return;
    try {
      await patchJson(`/api/master/sku/${skuId}/identifiers`, {
        identifierId: row.id,
        isPrimary: true,
      });
      message.success("主标识已更新");
      await load();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  return (
    <>
      <Drawer
        title={sku ? (
          <Space size={8}>
            <span>SKU 标识</span>
            <Typography.Text code>{sku.code}</Typography.Text>
          </Space>
        ) : "SKU 标识"}
        width={860}
        open={sku != null}
        onClose={onClose}
        destroyOnHidden
        extra={canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记标识
          </Button>
        ) : null}
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="S1 是内部稳定主码；GTIN 与外部编码独立登记"
            description="同一 SKU 可按单品、内包、箱、托盘维护不同 GTIN，也可同时维护聚水潭、用友、供应商、客户和历史编码。不要把包装、渠道或交易伙伴编码写进永久 SKU 主码。"
          />
          <Table<IdentifierRow>
            rowKey="id"
            size="small"
            loading={loading}
            pagination={false}
            scroll={{ x: 760 }}
            dataSource={rows}
            locale={{ emptyText: "尚未登记交换标识" }}
            columns={[
              {
                title: "类型",
                dataIndex: "kind",
                width: 140,
                render: (value: IdentifierRow["kind"]) => KIND_LABELS[value],
              },
              {
                title: "标识值",
                dataIndex: "value",
                width: 180,
                render: (value: string) => <Typography.Text copyable>{value}</Typography.Text>,
              },
              { title: "作用域", dataIndex: "scope", width: 100 },
              {
                title: "包装层级",
                dataIndex: "packagingLevel",
                width: 100,
                render: (value: IdentifierRow["packagingLevel"]) => value ? LEVEL_LABELS[value] : "—",
              },
              { title: "单位", dataIndex: "uom", width: 80, render: (value: string | null) => value ?? "—" },
              {
                title: "状态",
                dataIndex: "active",
                width: 110,
                render: (_value: boolean, row) => (
                  <Space size={4}>
                    <Tag color={row.active ? "success" : "default"}>{row.active ? "有效" : "停用"}</Tag>
                    {row.isPrimary ? <Tag color="processing">主标识</Tag> : null}
                  </Space>
                ),
              },
              {
                title: "操作",
                width: 150,
                fixed: "right",
                render: (_value: unknown, row) => canWrite ? (
                  <Space size={0}>
                    {row.active && !row.isPrimary ? (
                      <Button type="link" size="small" onClick={() => void promotePrimary(row)}>
                        设为主标识
                      </Button>
                    ) : null}
                    <Button type="link" size="small" danger={row.active} onClick={() => toggleActive(row)}>
                      {row.active ? "停用" : "启用"}
                    </Button>
                  </Space>
                ) : null,
              },
            ]}
          />
        </Space>
      </Drawer>
      <Modal
        title="登记 SKU 标识"
        zIndex={1200}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void create()}
        confirmLoading={saving}
        okText="登记"
        cancelText="取消"
        forceRender
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{ kind: "gtin", scope: "GS1", isPrimary: true }}
        >
          <Form.Item name="kind" label="标识类型" rules={[{ required: true }]}>
            <Select
              options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
              onChange={(value: IdentifierRow["kind"]) => {
                form.setFieldValue("scope", value === "gtin" ? "GS1" : undefined);
                if (value !== "gtin") form.setFieldValue("packagingLevel", undefined);
              }}
            />
          </Form.Item>
          <Form.Item
            name="value"
            label="标识值"
            rules={[{ required: true, message: "标识值必填" }]}
            extra={kind === "gtin" ? "支持 GTIN-8/12/13/14，系统会验证 GS1 校验位。" : undefined}
          >
            <Input maxLength={100} autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="scope"
            label="作用域 / 来源"
            rules={[{
              required: kind === "gtin" || kind === "external" || kind === "vendor" || kind === "customer",
              message: "请填写来源系统、供应商或客户短码",
            }]}
          >
            <Input
              maxLength={40}
              disabled={kind === "gtin"}
              placeholder={kind === "external" ? "如 JST / YONYOU" : "如供应商或客户短码"}
            />
          </Form.Item>
          {kind === "gtin" ? (
            <Form.Item name="packagingLevel" label="包装层级" rules={[{ required: true, message: "请选择包装层级" }]}>
              <Select options={Object.entries(LEVEL_LABELS).map(([value, label]) => ({ value, label }))} />
            </Form.Item>
          ) : null}
          <Form.Item name="uom" label="对应单位">
            <Input maxLength={20} placeholder="如 盒 / 箱 / 个" />
          </Form.Item>
          <Form.Item name="isPrimary" label="设为该层级主标识" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea maxLength={200} rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
