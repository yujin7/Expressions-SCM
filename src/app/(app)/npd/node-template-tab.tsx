"use client";

/**
 * NPD 节点模板（D19：核心 1.x——节点标准/角色分配的只读底稿）。
 *
 * W2：本视图曾是独立路由 `/report/npd`「NPD 节点参考」，与 `/npd`「NPD 项目跟踪」同在
 * 「新品开发」菜单组里并排——而它正是 /npd 建项目时实例化用的那套模板
 * （struct#6：模板存 transit_refs(kind=npd_node/npd_role)，建项目时快照进 npd_tasks）。
 * 现并为 /npd 的「节点模板」页签，旧路径保留跳转。
 *
 * 同时修掉页签上的**硬编码计数**：两个标签此前把条数写死在括号里（69 与 19），
 * 模板重导后条数变了标签也不会变——一个永远说 69 的标签比不写数字更糟。现按实际行数渲染。
 */
import { useEffect, useState } from "react";
import { Alert, App, Table, Tabs, Tag } from "antd";
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

interface KindState {
  rows: Row[];
  loading: boolean;
  error: string | null;
}

function useKind(kind: string): KindState {
  const { message } = App.useApp();
  const [state, setState] = useState<KindState>({ rows: [], loading: true, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fetchJson<{ rows: Row[] }>(`/api/report/transit?kind=${kind}&page=1&pageSize=200`)
      .then((d) => { if (alive) setState({ rows: d.rows, loading: false, error: null }); })
      .catch((e) => {
        if (alive) setState({ rows: [], loading: false, error: (e as Error).message });
        message.error((e as Error).message);
      });
    return () => { alive = false; };
  }, [kind, message]);
  return state;
}

function NodesTab({ state }: { state: KindState }) {
  const rows = state.rows;
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
  return (
    <Table<Row>
      rowKey="id"
      size="small"
      columns={cols}
      loading={state.loading}
      dataSource={sorted}
      pagination={false}
      scroll={{ x: "max-content" }}
      locale={{ emptyText: state.error ? `节点模板未加载：${state.error}` : "尚未登记节点标准模板" }}
    />
  );
}

function RolesTab({ state }: { state: KindState }) {
  const cols: ColumnsType<Row> = [
    { title: "角色", dataIndex: "materialName", width: 240 },
    { title: "分配方式", dataIndex: "follower", render: (v: string | null) => v ?? "—" },
  ];
  return (
    <Table<Row>
      rowKey="id"
      size="small"
      columns={cols}
      loading={state.loading}
      dataSource={state.rows}
      pagination={false}
      scroll={{ x: "max-content" }}
      locale={{ emptyText: state.error ? `角色模板未加载：${state.error}` : "尚未登记角色分配模板" }}
    />
  );
}

/** 页签标签的条数只在真的加载出来之后才写——加载中/失败时写数字就是在编 */
function countLabel(base: string, state: KindState): string {
  if (state.loading || state.error) return base;
  return `${base}（${state.rows.length}）`;
}

export default function NodeTemplateTab() {
  const nodes = useKind("npd_node");
  const roles = useKind("npd_role");
  return (
    <div>
      <Alert style={{ marginBottom: 12 }} type="info" showIcon
        message="口径（D19）：「各节点核心说明」三件套的合并只读登记（节点标准 + 角色分配 + 模拟工期），是本页「新建 NPD 项目」实例化用的模板底稿。模板存 transit_refs，建项目时快照进 npd_tasks——重导模板不影响在跑项目。" />
      <Tabs
        size="small"
        defaultActiveKey="nodes"
        items={[
          { key: "nodes", label: countLabel("节点标准", nodes), children: <NodesTab state={nodes} /> },
          { key: "roles", label: countLabel("角色分配", roles), children: <RolesTab state={roles} /> },
        ]}
      />
    </div>
  );
}
