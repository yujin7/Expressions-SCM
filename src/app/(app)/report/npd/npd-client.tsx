"use client";

/** NPD 节点参考（D19：核心 1.x——本页为节点标准/角色分配的只读底稿） */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";

interface Row {
  id: number;
  approvalNo: string | null; // 节点编号
  materialName: string | null; // 节点名称/角色名
  orderType: string | null; // 阶段
  follower: string | null; // 部门/岗位 或 分配方式
  qty: string | null; // 标准天数
  orderDate: string | null;
  expectDate: string | null;
  exception: string | null; // 职责说明
  extra: Record<string, unknown> | null;
}

function useKind(kind: string) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    fetchJson<{ rows: Row[] }>(`/api/report/transit?kind=${kind}&page=1&pageSize=200`)
      .then((d) => setRows(d.rows))
      .catch((e) => message.error((e as Error).message));
  }, [kind, message]);
  return rows;
}

function NodesTab() {
  const rows = useKind("npd_node");
  const sorted = [...rows].sort((a, b) => (a.approvalNo ?? "").localeCompare(b.approvalNo ?? "", "zh-CN"));
  const cols: ColumnsType<Row> = [
    { title: "节点", dataIndex: "materialName", width: 260, ellipsis: true },
    { title: "阶段", dataIndex: "orderType", width: 120, render: (v: string | null) => <Tag>{v ?? "—"}</Tag> },
    { title: "责任部门/岗位", dataIndex: "follower", width: 200, ellipsis: true, render: (v: string | null) => v ?? "—" },
    { title: "标准天数", dataIndex: "qty", width: 90, align: "right", render: (v: string | null) => (v == null ? "—" : Number(v)) },
    { title: "模拟起止", width: 190, render: (_, r) => (r.orderDate ? `${r.orderDate} ~ ${r.expectDate ?? "—"}` : "—") },
    { title: "职责说明", dataIndex: "exception", ellipsis: true, render: (v: string | null) => v ?? "—" },
    { title: "上一节点", width: 180, ellipsis: true, render: (_, r) => String(r.extra?.上一节点 ?? "—") },
  ];
  return <Table<Row> rowKey="id" size="small" columns={cols} dataSource={sorted} pagination={false} scroll={{ x: "max-content" }} />;
}

function RolesTab() {
  const rows = useKind("npd_role");
  const cols: ColumnsType<Row> = [
    { title: "角色", dataIndex: "materialName", width: 240 },
    { title: "分配方式", dataIndex: "follower", render: (v: string | null) => v ?? "—" },
  ];
  return <Table<Row> rowKey="id" size="small" columns={cols} dataSource={rows} pagination={false} />;
}

export default function NpdClient() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>NPD 节点参考</Typography.Title>
      <Alert style={{ marginBottom: 12 }} type="info" showIcon
        message="口径（D19）：NPD 核心流程 1.x 实现；本页为「各节点核心说明」三件套的合并只读登记（69 节点 + 19 角色 + 模拟工期），作为 1.x 配置底稿与业务对齐材料。MVP 已挂钩：订单类型（新品首单）与生命周期（试销）。" />
      <Tabs defaultActiveKey="nodes" items={[
        { key: "nodes", label: "节点标准（69）", children: <NodesTab /> },
        { key: "roles", label: "角色分配（19）", children: <RolesTab /> },
      ]} />
    </div>
  );
}
