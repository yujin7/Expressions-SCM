"use client";

import { useRef, useState } from "react";
import { Button, Descriptions, Drawer, Form, Input, Select, Skeleton, Space, Switch, Table, Tag, Typography } from "antd";
import CrudTable from "@/components/CrudTable";
import { useDocumentRead } from "@/components/useDocumentRead";
import { useListState } from "@/components/useListState";
import LoadErrorAlert from "@/components/LoadErrorAlert";
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
  regionCode: string;
  supplierId: number | null;
  supplierName: string | null;
  parentId: number | null;
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
  warehouse: { id: number; code: string; name: string; kind: string; accountingMode: string; regionCode: string };
  totals: { total: string; skuCount: number };
  topStock: { skuCode: string; skuName: string; baseUom: string; qty: string; bizDate?: string }[];
  recentLedger: { occurredAt: string; skuCode: string; qtyDelta: string; sourceDocType: string }[];
  batches: { skuCode: string; expiryDate: string; qty: string }[];
  snapDates: { bizDate: string; total: string }[];
}

/** 仓库 360（0724 会议：单仓维度全链路） */
export function WarehousePanoramaDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const read = useDocumentRead<WhPanorama>(id == null ? null : `/api/master/warehouse/${id}/panorama`);
  const candidate = read.data;
  const valid = candidate?.warehouse?.id === id && typeof candidate?.totals?.total === "string"
    && Number.isSafeInteger(candidate?.totals?.skuCount)
    && [candidate?.topStock, candidate?.recentLedger, candidate?.batches, candidate?.snapDates].every(Array.isArray);
  const data = valid ? candidate : null;
  const error = read.error ?? (read.phase === "success" && !valid ? "仓库响应与当前选择不一致或格式异常" : null);
  const content = useRef<HTMLDivElement>(null);
  const retry = () => { content.current?.focus({ preventScroll: true }); read.retry(); };
  const rt = data?.warehouse.accountingMode === "realtime";
  return (
    <Drawer
      title={data ? `仓库 360 — ${data.warehouse.code} ${data.warehouse.name}` : "仓库 360"}
      width="min(680px, 100vw)"
      open={id != null}
      onClose={onClose}
      destroyOnHidden
    >
      <div ref={content} tabIndex={-1}>
      <LoadErrorAlert error={error} subject="仓库全景" onRetry={retry} retrying={read.phase === "loading"} />
      {read.phase === "loading" ? (
        <Skeleton active />
      ) : data ? (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 2 }} bordered>
            <Descriptions.Item label="类型">{WAREHOUSE_KIND_LABELS[data.warehouse.kind] ?? data.warehouse.kind}</Descriptions.Item>
            <Descriptions.Item label="记账">{rt ? "实时账" : "快照参考"}</Descriptions.Item>
            <Descriptions.Item label="区域">{data.warehouse.regionCode}</Descriptions.Item>
            <Descriptions.Item label="SKU 数 / 合计">{data.totals.skuCount} / {formatQty(data.totals.total)}</Descriptions.Item>
          </Descriptions>
          <div>
            <Typography.Text strong>库存 TOP20{rt ? "（实时账）" : `（快照 ${data.topStock[0]?.bizDate ?? ""}）`}</Typography.Text>
            <Table
              rowKey="skuCode"
              size="small"
              scroll={{ x: 500 }}
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
                scroll={{ x: 420 }}
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
                scroll={{ x: 550 }}
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
      ) : null}
      </div>
    </Drawer>
  );
}

export default function WarehouseClient() {
  const list = useListState({ key: "master-warehouse", defaults: { q: "", sort: "code", order: "asc" }, defaultPageSize: 20, defaultDensity: "middle" });
  const sortOrder = (key: string) => list.filters.sort === key ? list.filters.order === "desc" ? "descend" as const : "ascend" as const : null;
  const me = useMe();
  const canWrite = hasAnyRole(me);
  const [panoId, setPanoId] = useState<number | null>(null);
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        仓库
      </Typography.Title>
      <CrudTable<WarehouseRow>
        listState={list}
        tableProps={{ onChange: (_page, _filters, sorter, extra) => {
          if (extra.action !== "sort") return;
          const current = Array.isArray(sorter) ? sorter[0] : sorter;
          list.setFilter({ sort: current.order ? String(current.columnKey) : "code", order: current.order === "descend" ? "desc" : "asc" });
        } }}
        loadDetailOnEdit
        canCreate={canWrite}
        canEdit={() => canWrite}
        entityName="仓库"
        rowActions={(r) => (
          <Space size={0}>
            <Button type="link" size="small" onClick={() => setPanoId(r.id)}>360</Button>
            {r.accountingMode === "realtime" ? (
              <Button type="link" size="small" href={`/inventory/locations?warehouseId=${r.id}`}>库位</Button>
            ) : null}
          </Space>
        )}
        apiPath="/api/master/warehouse"
        searchPlaceholder="搜索编码/名称"
        columns={[
          { title: "编码", key: "code", dataIndex: "code", width: 140, sorter: true, sortOrder: sortOrder("code") },
          { title: "名称", key: "name", dataIndex: "name", sorter: true, sortOrder: sortOrder("name") },
          {
            title: "类型",
            dataIndex: "kind",
            width: 110,
            render: (v: string) => <Tag color={KIND_COLORS[v]}>{WAREHOUSE_KIND_LABELS[v] ?? v}</Tag>,
          },
          {
            title: "记账",
            dataIndex: "accountingMode",
            width: 100,
            render: (v: string) => v === "realtime" ? <Tag color="processing">实时账</Tag> : <Tag>快照参考</Tag>,
          },
          {
            title: "区域",
            key: "regionCode",
            dataIndex: "regionCode",
            width: 80,
            sorter: true,
            sortOrder: sortOrder("regionCode"),
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
        formItems={(editing) => (
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
            <Form.Item
              name="regionCode"
              label="运营区域"
              initialValue="CN"
              tooltip="ISO 两位区域代码；不依据仓名猜测海外归属"
              rules={[
                { required: true, message: "运营区域必填" },
                { pattern: /^[A-Za-z]{2}$/, message: "请输入两位字母，如 CN、HK、US" },
              ]}
              normalize={(value: string) => value?.trim().toUpperCase()}
            >
              <Input maxLength={2} placeholder="CN" style={{ textTransform: "uppercase" }} />
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
            <Form.Item
              name="parentId"
              label="上级仓库"
              tooltip="D32 树状层级；不能选择自身或自己的下级"
            >
              <RemoteSelect
                allowClear
                api="/api/master/warehouse"
                getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                filterRow={(r) => r.id !== editing?.id}
                placeholder="留空表示顶级仓库"
              />
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
