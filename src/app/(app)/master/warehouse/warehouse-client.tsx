"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Descriptions, Drawer, Form, Input, Select, Skeleton, Space, Switch, Table, Tag, Typography } from "antd";
import CrudTable from "@/components/CrudTable";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { hasAnyRole, useMe } from "@/components/useMe";
import RemoteSelect from "@/components/RemoteSelect";
import { WAREHOUSE_KIND_LABELS, toOptions } from "@/components/labels";

interface WarehouseRow {
  id: number;
  code: string;
  name: string;
  kind: string;
  accountingMode: string;
  supplierId: number | null;
  supplierName: string | null;
  active: boolean;
}

const KIND_COLORS: Record<string, string> = {
  finished: "blue",
  raw: "green",
  packaging: "orange",
  outsource: "purple",
  transit: "cyan",
  snapshot: "default",
};


interface WhPanorama {
  warehouse: { id: number; code: string; name: string; kind: string; accountingMode: string };
  totals: { total: string; skuCount: number };
  topStock: { skuCode: string; skuName: string; baseUom: string; qty: string; bizDate?: string }[];
  recentLedger: { occurredAt: string; skuCode: string; qtyDelta: string; sourceDocType: string }[];
  batches: { skuCode: string; expiryDate: string; qty: string }[];
  snapDates: { bizDate: string; total: string }[];
}

/** 仓库 360（0724 会议：单仓维度全链路） */
function WarehousePanoramaDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const [data, setData] = useState<WhPanorama | null>(null);
  const load = useCallback(async () => {
    if (id == null) return;
    setData(null);
    setData(await fetchJson<WhPanorama>(`/api/master/warehouse/${id}/panorama`));
  }, [id]);
  useEffect(() => {
    void load().catch(() => setData(null));
  }, [load]);
  const rt = data?.warehouse.accountingMode === "realtime";
  return (
    <Drawer
      title={data ? `仓库 360 — ${data.warehouse.code} ${data.warehouse.name}` : "仓库 360"}
      width={680}
      open={id != null}
      onClose={onClose}
      destroyOnHidden
    >
      {!data ? (
        <Skeleton active />
      ) : (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="类型">{WAREHOUSE_KIND_LABELS[data.warehouse.kind] ?? data.warehouse.kind}</Descriptions.Item>
            <Descriptions.Item label="记账">{rt ? "实时账" : "快照参考"}</Descriptions.Item>
            <Descriptions.Item label="SKU 数 / 合计">{data.totals.skuCount} / {formatQty(data.totals.total)}</Descriptions.Item>
          </Descriptions>
          <div>
            <Typography.Text strong>库存 TOP20{rt ? "（实时账）" : `（快照 ${data.topStock[0]?.bizDate ?? ""}）`}</Typography.Text>
            <Table
              rowKey="skuCode"
              size="small"
              pagination={false}
              dataSource={data.topStock}
              columns={[
                { title: "编码", dataIndex: "skuCode", width: 130, render: (v: string) => <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a> },
                { title: "名称", dataIndex: "skuName", ellipsis: true },
                { title: "数量", dataIndex: "qty", width: 110, align: "right" as const, render: (v: string) => formatQty(v) },
                { title: "单位", dataIndex: "baseUom", width: 70 },
              ]}
            />
          </div>
          {data.batches.length > 0 ? (
            <div>
              <Typography.Text strong>本仓近效期批次 TOP10</Typography.Text>
              <Table
                rowKey={(r: WhPanorama["batches"][number]) => `${r.skuCode}-${r.expiryDate}`}
                size="small"
                pagination={false}
                dataSource={data.batches}
                columns={[
                  { title: "编码", dataIndex: "skuCode", width: 140 },
                  { title: "到期日", dataIndex: "expiryDate", width: 120 },
                  { title: "数量", dataIndex: "qty", width: 100, align: "right" as const, render: (v: string) => formatQty(v) },
                ]}
              />
            </div>
          ) : null}
          {rt && data.recentLedger.length > 0 ? (
            <div>
              <Typography.Text strong>近 10 条流水</Typography.Text>
              <Table
                rowKey={(r: WhPanorama["recentLedger"][number], i) => `${r.occurredAt}-${i}`}
                size="small"
                pagination={false}
                dataSource={data.recentLedger}
                columns={[
                  { title: "时间", dataIndex: "occurredAt", width: 160, render: (v: string) => new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) },
                  { title: "编码", dataIndex: "skuCode", width: 130 },
                  { title: "变动", dataIndex: "qtyDelta", width: 100, align: "right" as const, render: (v: string) => <span style={{ color: Number(v) < 0 ? "#cf1322" : "#3f8600" }}>{formatQty(v)}</span> },
                  { title: "来源", dataIndex: "sourceDocType", width: 120 },
                ]}
              />
            </div>
          ) : null}
          {!rt && data.snapDates.length > 0 ? (
            <div>
              <Typography.Text strong>快照期数（近 6 期合计）</Typography.Text>
              <Space wrap>
                {data.snapDates.map((d) => (
                  <Tag key={d.bizDate}>{d.bizDate}: {formatQty(d.total)}</Tag>
                ))}
              </Space>
            </div>
          ) : null}
        </Space>
      )}
    </Drawer>
  );
}

export default function WarehouseClient() {
  const me = useMe();
  const canWrite = hasAnyRole(me);
  const [panoId, setPanoId] = useState<number | null>(null);
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        仓库
      </Typography.Title>
      <CrudTable<WarehouseRow>
        canCreate={canWrite}
        canEdit={() => canWrite}
        entityName="仓库"
        rowActions={(r) => <Button type="link" size="small" onClick={() => setPanoId(r.id)}>360</Button>}
        apiPath="/api/master/warehouse"
        searchPlaceholder="搜索编码/名称"
        columns={[
          { title: "编码", dataIndex: "code", width: 140 },
          { title: "名称", dataIndex: "name" },
          {
            title: "类型",
            dataIndex: "kind",
            width: 110,
            render: (v: string) => <Tag color={KIND_COLORS[v]}>{WAREHOUSE_KIND_LABELS[v] ?? v}</Tag>,
          },
          {
            title: "关联供应商",
            dataIndex: "supplierName",
            width: 160,
            render: (v: string | null) => v ?? "—",
          },
          {
            title: "状态",
            dataIndex: "active",
            width: 80,
            render: (v: boolean) => (v ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>),
          },
        ]}
        formItems={() => (
          <>
            <Form.Item name="code" label="编码" rules={[{ required: true, message: "编码必填" }]}>
              <Input maxLength={30} placeholder="如 WH-CP" />
            </Form.Item>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: "名称必填" }]}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="kind" label="类型" rules={[{ required: true, message: "必须选择仓库类型" }]}>
              <Select options={toOptions(WAREHOUSE_KIND_LABELS)} placeholder="选择仓库类型" />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, cur) => prev.kind !== cur.kind}>
              {({ getFieldValue }) =>
                getFieldValue("kind") === "outsource" ? (
                  <Form.Item
                    name="supplierId"
                    label="委外供应商"
                    tooltip="委外仓按加工厂建仓，允许负余额=垫料"
                    rules={[{ required: true, message: "委外仓必须指定供应商" }]}
                  >
                    <RemoteSelect
                      api="/api/master/supplier"
                      getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                      filterRow={(r) => Array.isArray(r.kinds) && (r.kinds as string[]).includes("processor")}
                      placeholder="选择加工厂"
                    />
                  </Form.Item>
                ) : null
              }
            </Form.Item>
            <Form.Item name="active" label="启用" valuePropName="checked" initialValue={true}>
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
          </>
        )}
      />
      <WarehousePanoramaDrawer id={panoId} onClose={() => setPanoId(null)} />
    </div>
  );
}
