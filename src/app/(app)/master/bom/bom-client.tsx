"use client";

import { App, Button, Form, Input, InputNumber, Popconfirm, Space, Table, Tag, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import CrudTable from "@/components/CrudTable";
import { hasAnyRole, useMe } from "@/components/useMe";
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
  const me = useMe();
  const canWrite = hasAnyRole(me, "pmc");
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
        canCreate={canWrite}
        entityName="BOM"
        apiPath="/api/master/bom"
        searchPlaceholder="搜索成品编码/名称/版本"
        modalWidth={860}
        canEdit={(r) => canWrite && r.status === "draft"}
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
                  validator: async (_, value: { materialSkuId?: number }[]) => {
                    if (!value || value.length === 0) throw new Error("至少需要一行物料");
                    // UX 走查 #8：重复物料校验
                    const ids = value.map((l) => l?.materialSkuId).filter(Boolean);
                    if (new Set(ids).size !== ids.length) throw new Error("存在重复物料，请合并用量");
                  },
                },
              ]}
            >
              {(fields, { add, remove }, { errors }) => {
                // UX 走查 #8：表格化编辑器——表头对齐 + 行号 + 滚动区（10+ 行可用）
                const grid = "40px 300px 130px 120px 110px 60px";
                const cell: React.CSSProperties = { padding: "2px 4px" };
                return (
                  <div style={{ marginTop: 8 }}>
                    <div
                      style={{
                        display: "grid", gridTemplateColumns: grid, fontWeight: 600,
                        background: "#fafafa", border: "1px solid #f0f0f0", borderBottom: 0, padding: "6px 0",
                      }}
                    >
                      <div style={{ ...cell, textAlign: "center" }}>#</div>
                      <div style={cell}>物料 SKU（原料/包材）</div>
                      <div style={cell}>单位用量</div>
                      <div style={cell}>损耗率%</div>
                      <div style={cell}>提前期(天)</div>
                      <div style={cell} />
                    </div>
                    <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid #f0f0f0" }}>
                      {fields.map((field, idx) => (
                        <div key={field.key} style={{ display: "grid", gridTemplateColumns: grid, alignItems: "start", borderBottom: "1px solid #f5f5f5" }}>
                          <div style={{ ...cell, textAlign: "center", paddingTop: 8 }}>{idx + 1}</div>
                          <Form.Item name={[field.name, "materialSkuId"]} rules={[{ required: true, message: "选择物料" }]} style={{ margin: 4 }}>
                            <RemoteSelect
                              api="/api/master/sku?type=raw,packaging"
                              getLabel={(r) => `${String(r.code)} ${r.name ? String(r.name) : String(r.spuNameCn)}`}
                              placeholder="物料 SKU"
                              style={{ width: 290 }}
                            />
                          </Form.Item>
                          <Form.Item name={[field.name, "qtyPer"]} rules={[{ required: true, message: "用量必填" }]} style={{ margin: 4 }}>
                            <InputNumber min={0.0001} step={0.0001} placeholder="用量" style={{ width: 120 }} />
                          </Form.Item>
                          <Form.Item name={[field.name, "lossRatePct"]} initialValue={0} style={{ margin: 4 }}>
                            <InputNumber min={0} max={100} step={0.5} style={{ width: 110 }} addonAfter="%" />
                          </Form.Item>
                          <Form.Item name={[field.name, "leadTimeDays"]} style={{ margin: 4 }}>
                            <InputNumber min={0} style={{ width: 100 }} />
                          </Form.Item>
                          <Button type="link" danger style={{ marginTop: 4 }} onClick={() => remove(field.name)}>
                            删除
                          </Button>
                        </div>
                      ))}
                    </div>
                    <Space style={{ marginTop: 8 }}>
                      <Button icon={<PlusOutlined />} onClick={() => add({ lossRatePct: 0 })}>
                        添加物料行
                      </Button>
                      <Typography.Text type="secondary">共 {fields.length} 行；Excel 批量导入见导入中心（DW2）</Typography.Text>
                    </Space>
                    <Form.ErrorList errors={errors} />
                  </div>
                );
              }}
            </Form.List>
          </>
        )}
      />
    </div>
  );
}
