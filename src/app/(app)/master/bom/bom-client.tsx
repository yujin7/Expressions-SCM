"use client";

import { App, Button, Form, Input, InputNumber, Popconfirm, Space, Table, Tag, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import CrudTable from "@/components/CrudTable";
import RemoteSelect from "@/components/RemoteSelect";
import { BOM_STATUS_COLORS, BOM_STATUS_LABELS } from "@/components/labels";
import { fetchJson } from "@/components/fetchJson";

interface BomLineRow {
  id: number;
  bomId: number;
  materialSkuId: number;
  materialSkuCode: string;
  materialName: string | null;
  materialSpec: string | null;
  baseUom: string;
  qtyPer: string;
  lossRatePct: string;
  leadTimeDays: number | null;
}

interface BomRow {
  id: number;
  productSkuId: number;
  productSkuCode: string;
  productName: string;
  productSpec: string | null;
  versionNo: string;
  status: string;
  effectiveDate: string | null;
  lines: BomLineRow[];
}

function LinesTable({ lines }: { lines: BomLineRow[] }) {
  return (
    <Table<BomLineRow>
      rowKey="id"
      size="small"
      pagination={false}
      dataSource={lines}
      columns={[
        {
          title: "物料 SKU",
          dataIndex: "materialSkuCode",
          render: (_, l) => `${l.materialSkuCode} ${l.materialName ?? ""}${l.materialSpec ? `（${l.materialSpec}）` : ""}`,
        },
        { title: "单位用量", dataIndex: "qtyPer", width: 110 },
        { title: "基础单位", dataIndex: "baseUom", width: 90 },
        { title: "损耗率%", dataIndex: "lossRatePct", width: 100 },
        {
          title: "提前期(天)",
          dataIndex: "leadTimeDays",
          width: 100,
          render: (v: number | null) => v ?? "—",
        },
      ]}
    />
  );
}

export default function BomClient() {
  const { message } = App.useApp();

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        BOM 版本
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        每个成品同一时间仅一个生效版本；生效即冻结行，改动需新建版本。
      </Typography.Paragraph>
      <CrudTable<BomRow>
        entityName="BOM"
        apiPath="/api/master/bom"
        searchPlaceholder="搜索成品编码/名称/版本"
        modalWidth={860}
        canEdit={(r) => r.status === "draft"}
        tableProps={{
          expandable: {
            expandedRowRender: (record) => <LinesTable lines={record.lines} />,
          },
        }}
        columns={[
          {
            title: "成品 SKU",
            dataIndex: "productSkuCode",
            render: (_, r) => `${r.productSkuCode} ${r.productName}${r.productSpec ? `（${r.productSpec}）` : ""}`,
          },
          { title: "版本", dataIndex: "versionNo", width: 90 },
          {
            title: "状态",
            dataIndex: "status",
            width: 90,
            render: (v: string) => <Tag color={BOM_STATUS_COLORS[v]}>{BOM_STATUS_LABELS[v] ?? v}</Tag>,
          },
          { title: "生效日期", dataIndex: "effectiveDate", width: 120, render: (v: string | null) => v ?? "—" },
          { title: "物料行数", dataIndex: "lines", width: 90, render: (lines: BomLineRow[]) => lines.length },
        ]}
        toFormValues={(r) => ({
          productSkuId: r.productSkuId,
          versionNo: r.versionNo,
          lines: r.lines.map((l) => ({
            materialSkuId: l.materialSkuId,
            qtyPer: Number(l.qtyPer),
            lossRatePct: Number(l.lossRatePct),
            leadTimeDays: l.leadTimeDays,
          })),
        })}
        rowActions={(record, reload) =>
          record.status === "draft" ? (
            <Popconfirm
              title="确认生效该 BOM？"
              description="同产品的其他生效版本将自动置为停用"
              okText="生效"
              cancelText="取消"
              onConfirm={async () => {
                try {
                  await fetchJson(`/api/master/bom/${record.id}/activate`, { method: "POST" });
                  message.success("BOM 已生效");
                  reload();
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            >
              <Button type="link" size="small">
                生效
              </Button>
            </Popconfirm>
          ) : null
        }
        formItems={() => (
          <>
            <Form.Item
              name="productSkuId"
              label="成品 SKU"
              rules={[{ required: true, message: "必须选择成品 SKU" }]}
            >
              <RemoteSelect
                api="/api/master/sku?type=finished"
                getLabel={(r) => `${String(r.code)} ${r.name ? String(r.name) : String(r.spuNameCn)}`}
                placeholder="选择成品"
                style={{ maxWidth: 400 }}
              />
            </Form.Item>
            <Form.Item name="versionNo" label="版本号" rules={[{ required: true, message: "版本号必填" }]} initialValue="V1">
              <Input maxLength={20} style={{ maxWidth: 200 }} />
            </Form.Item>
            <Typography.Text strong>物料行</Typography.Text>
            <Form.List
              name="lines"
              rules={[
                {
                  validator: async (_, value: unknown[]) => {
                    if (!value || value.length === 0) throw new Error("至少需要一行物料");
                  },
                },
              ]}
            >
              {(fields, { add, remove }, { errors }) => (
                <div style={{ marginTop: 8 }}>
                  {fields.map((field) => (
                    <Space key={field.key} align="baseline" wrap style={{ display: "flex", marginBottom: 4 }}>
                      <Form.Item
                        name={[field.name, "materialSkuId"]}
                        rules={[{ required: true, message: "选择物料" }]}
                        style={{ marginBottom: 8 }}
                      >
                        <RemoteSelect
                          api="/api/master/sku?type=raw,packaging"
                          getLabel={(r) => `${String(r.code)} ${r.name ? String(r.name) : String(r.spuNameCn)}`}
                          placeholder="物料 SKU（原料/包材）"
                          style={{ width: 300 }}
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "qtyPer"]}
                        rules={[{ required: true, message: "用量必填" }]}
                        style={{ marginBottom: 8 }}
                      >
                        <InputNumber min={0.0001} step={0.0001} placeholder="单位用量" style={{ width: 120 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, "lossRatePct"]} initialValue={0} style={{ marginBottom: 8 }}>
                        <InputNumber min={0} max={100} step={0.5} placeholder="损耗率%" style={{ width: 110 }} addonAfter="%" />
                      </Form.Item>
                      <Form.Item name={[field.name, "leadTimeDays"]} style={{ marginBottom: 8 }}>
                        <InputNumber min={0} placeholder="提前期(天)" style={{ width: 120 }} />
                      </Form.Item>
                      <Button type="link" danger onClick={() => remove(field.name)}>
                        删除
                      </Button>
                    </Space>
                  ))}
                  <Button icon={<PlusOutlined />} onClick={() => add({ lossRatePct: 0 })}>
                    添加物料行
                  </Button>
                  <Form.ErrorList errors={errors} />
                </div>
              )}
            </Form.List>
          </>
        )}
      />
    </div>
  );
}
