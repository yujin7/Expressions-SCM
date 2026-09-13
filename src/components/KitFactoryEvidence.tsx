"use client";

import Link from "next/link";
import { Alert, Button, Space, Table, Tag, Typography } from "antd";
import type { KitFactoryEvidence as Evidence } from "@/server/modules/outsource/kit-factory-evidence";
import { useDocumentRead } from "./useDocumentRead";
import { formatQty } from "./format";
import LoadErrorAlert from "./LoadErrorAlert";

/** Mounted only inside the selected WO's evidence dialog: no per-WO first-screen waterfall. */
export default function KitFactoryEvidence({ woId }: { woId: number }) {
  const read = useDocumentRead<Evidence>(`/api/outsource/auto-chain/evidence?woId=${woId}`);
  const data = read.data?.woId === woId && read.data.allocationStatus === "unverified"
    && Array.isArray(read.data.materials) && Array.isArray(read.data.warehouses) ? read.data : null;
  const error = read.error ?? (read.phase === "success" && !data ? "工单依据不完整或身份不符，请重新核对" : null);
  return <section aria-label="加工厂库存与占用核对">
    <Space wrap style={{ marginBlock: 12 }}>
      <Typography.Title level={5} style={{ margin: 0 }}>加工厂库存与占用核对</Typography.Title>
      <Button size="small" loading={read.phase === "loading"} onClick={read.retry}>刷新到厂依据</Button>
    </Space>
    <LoadErrorAlert subject="到厂依据" error={error} onRetry={read.retry} retrying={read.phase === "loading"} />
    {read.phase === "loading" ? <Typography.Paragraph role="status">正在读取当前工单的加工厂、物料与库存记录…</Typography.Paragraph> : null}
    {data ? <>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        {data.supplierName} · 工单版本 {data.woVersion} · 读取 {new Date(data.observedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
      </Typography.Paragraph>
      <Alert type="warning" showIcon message="本单可领用量尚未确认" style={{ marginBottom: 12 }}
        description="以下为加工厂关联委外仓的账面观察，不是库存预留。展开物料核对隔离、效期和同厂工单；各风险数量可能重叠，不能相加后扣减。在厂余额也不是本工单净发料，不与历史发退料相加。" />
      {!data.warehouses.length ? <Alert type="info" showIcon message="尚未关联加工厂委外仓，不能判断到厂库存" description="请主数据负责人核对仓库的加工厂归属；下表保留未知，不填零。" style={{ marginBottom: 12 }} /> : null}
      <Table<Evidence["materials"][number]> aria-label="加工厂逐料核对" rowKey="skuId" size="small" tableLayout="fixed" scroll={{ x: 650 }}
        dataSource={data.materials} pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: "工单没有物料需求记录，不能判断齐套" }}
        columns={[
          { title: "物料 / 单位", key: "material", width: 270, render: (_, row) => <><span>{row.code} · {row.unit}</span><div style={{ overflowWrap: "anywhere" }}>{row.name || "名称未补录"}</div></> },
          { title: "全单毛需求", dataIndex: "required", width: 110, align: "right", render: formatQty },
          { title: "在厂账面", dataIndex: "factoryOnHand", width: 110, align: "right", render: value => value === null ? "未知" : formatQty(value) },
          { title: "同厂其他工单", key: "peers", width: 120, align: "right", render: (_, row) => row.peers.length },
        ]}
        expandable={{ expandedRowRender: row => <Space direction="vertical" size={12} style={{ width: "100%", maxWidth: "calc(100vw - 128px)", minWidth: 0 }}>
          <Typography.Text type="secondary">在厂账面含停用委外仓余额及负余额。隔离量含停用隔离位；未记录隔离不等于质量已放行。未标效期不等于过期。</Typography.Text>
          <Table<Evidence["materials"][number]["warehouses"][number]> aria-label={`${row.code} 分仓风险依据`} rowKey="warehouseId" size="small" tableLayout="fixed" scroll={{ x: 790 }}
            dataSource={row.warehouses} pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: "未关联委外仓" }} columns={[
              { title: "委外仓", key: "warehouse", width: 220, render: (_, balance) => { const warehouse = data.warehouses.find(w => w.id === balance.warehouseId); return <div style={{ overflowWrap: "anywhere" }}>{warehouse?.code} · {warehouse?.name}{warehouse && !warehouse.active ? <Tag>已停用</Tag> : null}</div>; } },
              { title: "账面", dataIndex: "onHand", width: 100, align: "right", render: formatQty },
              { title: "隔离位记录", dataIndex: "quarantine", width: 110, align: "right", render: formatQty },
              { title: "已过期正库存", dataIndex: "expired", width: 120, align: "right", render: formatQty },
              { title: "未辨识批次", dataIndex: "unidentifiedBatch", width: 120, align: "right", render: formatQty },
              { title: "批次未标效期", dataIndex: "undatedBatch", width: 120, align: "right", render: formatQty },
            ]} />
          <Typography.Text type="secondary">以下仅为同厂、同物料的已审批/执行中工单全单需求，不是剩余需求或已占用量；暂停工单仍列出供核对。</Typography.Text>
          <Table<Evidence["materials"][number]["peers"][number]> aria-label={`${row.code} 同厂工单`} rowKey="id" size="small" tableLayout="fixed" scroll={{ x: 440 }}
            dataSource={row.peers} pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: "没有匹配的其他工单；不代表库存已分配给本单" }} columns={[
              { title: "工单 / 核对物料", key: "doc", width: 240, render: (_, peer) => <><Link href={`/outsource/wo?docId=${peer.id}`}>{peer.docNo}</Link>{peer.paused ? <Tag>已暂停</Tag> : null}</> },
              { title: "全单毛需求", dataIndex: "required", width: 150, align: "right", render: formatQty },
            ]} />
        </Space> }} />
    </> : null}
  </section>;
}
