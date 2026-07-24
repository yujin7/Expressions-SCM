"use client";

/**
 * 在途参考（D16 新旧划断执行面）：存量在途订单/包材/备料/OEM 归属只读登记。
 * 数据来自「在途进度表」月度重导（整类替换），带数据龄标注；绝不入账本。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Input, Space, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";

interface Row {
  id: number;
  brandRaw: string | null;
  skuCode: string | null;
  skuId: number | null;
  materialCode: string | null;
  materialName: string | null;
  oemRaw: string | null;
  externalNo: string | null;
  approvalNo: string | null;
  feishuNo: string | null;
  orderType: string | null;
  qty: string | null;
  doneQty: string | null;
  inboundQty: string | null;
  closedQty: string | null;
  usedQty: string | null;
  remainQty: string | null;
  orderDate: string | null;
  needDate: string | null;
  replyDate: string | null;
  expectDate: string | null;
  startDate: string | null;
  progress: string | null;
  urgentDept: string | null;
  follower: string | null;
  exception: string | null;
}

const PROGRESS_COLORS: Record<string, string> = {
  待采购下单: "default",
  待包材回货: "orange",
  包材已齐套: "gold",
  成品生产中: "processing",
  成品待提货: "cyan",
  成品待入库: "blue",
  订单已完结: "green",
};

const qn = (v: string | null) => (v == null ? "—" : formatQty(v));

/**
 * 每个 Tab 一份独立列表状态：paramPrefix 给 URL 参数分命名空间（fg_q / pkgo_q …），
 * 写 URL 时只增删自己的参数，兄弟 Tab 的筛选不会被清空。
 */
function useTransit(kind: string, prefix: string) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [importedAt, setImportedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const listState = useListState({
    key: `transit-${kind}`,
    paramPrefix: prefix,
    defaults: { q: "" },
    defaultPageSize: 20,
  });
  const { page, pageSize } = listState;
  const q = listState.filters.q;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ kind, q, page: String(page), pageSize: String(pageSize) });
      const res = await fetchJson<{ rows: Row[]; total: number; importedAt: string | null }>(
        `/api/report/transit?${params.toString()}`,
      );
      setRows(res.rows);
      setTotal(res.total);
      setImportedAt(res.importedAt);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [kind, q, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  return { rows, total, importedAt, loading, listState };
}

function KindTable({ kind, prefix, columns }: { kind: string; prefix: string; columns: ColumnsType<Row> }) {
  const t = useTransit(kind, prefix);
  const { listState } = t;
  const q = listState.filters.q;
  const age =
    t.importedAt != null
      ? Math.max(0, Math.floor((Date.now() - new Date(t.importedAt).getTime()) / 86_400_000))
      : null;
  return (
    <div>
      <ListToolbar
        state={listState}
        extra={
          <>
            <Input.Search
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索编码/名称/审批号/用友单号"
              style={{ width: 300 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
            {age != null ? (
              <Tag color={age <= 7 ? "green" : age <= 30 ? "orange" : "red"}>数据导入于 {age === 0 ? "今日" : `${age} 天前`}</Tag>
            ) : (
              <Tag>尚未导入</Tag>
            )}
          </>
        }
      />
      <Table<Row>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={t.rows}
        loading={t.loading}
        scroll={{ x: "max-content" }}
        pagination={{
          current: listState.page,
          pageSize: listState.pageSize,
          total: t.total,
          showSizeChanger: true,
          showTotal: (n) => `共 ${n} 条`,
          onChange: (p, ps) => listState.setPage(p, ps),
        }}
      />
    </div>
  );
}

const skuCol: ColumnsType<Row>[number] = {
  title: "成品编码",
  dataIndex: "skuCode",
  width: 130,
  render: (v: string | null, r) =>
    v ? (
      <Space size={4}>
        <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>
        {r.skuId == null ? <Tag color="default">未建档</Tag> : null}
      </Space>
    ) : (
      "—"
    ),
};

const fgCols: ColumnsType<Row> = [
  { title: "品牌", dataIndex: "brandRaw", width: 110 },
  skuCol,
  { title: "名称", dataIndex: "materialName", ellipsis: true, width: 200 },
  { title: "订单类型", dataIndex: "orderType", width: 100 },
  { title: "OEM", dataIndex: "oemRaw", width: 80 },
  { title: "钉钉审批号", dataIndex: "approvalNo", width: 140 },
  { title: "用友单号", dataIndex: "externalNo", width: 120, render: (v: string | null) => v ?? "—" },
  { title: "下单日", dataIndex: "orderDate", width: 105 },
  { title: "订单量", dataIndex: "qty", width: 90, align: "right", render: qn },
  { title: "已完工", dataIndex: "doneQty", width: 90, align: "right", render: qn },
  { title: "已入库", dataIndex: "inboundQty", width: 90, align: "right", render: qn },
  { title: "关单", dataIndex: "closedQty", width: 80, align: "right", render: qn },
  { title: "预计入仓", dataIndex: "expectDate", width: 105, render: (v: string | null) => v ?? "—" },
  {
    title: "进度",
    dataIndex: "progress",
    width: 110,
    render: (v: string | null, r) => {
      const label = v ?? (r.inboundQty && r.qty && Number(r.inboundQty) >= Number(r.qty) ? "订单已完结" : "进行中");
      return <Tag color={PROGRESS_COLORS[label] ?? "processing"}>{label}</Tag>;
    },
  },
  { title: "异常", dataIndex: "exception", ellipsis: true, width: 180, render: (v: string | null) => v ?? "—" },
];

const pkgCols: ColumnsType<Row> = [
  { title: "品牌", dataIndex: "brandRaw", width: 110 },
  skuCol,
  { title: "物料编码", dataIndex: "materialCode", width: 150 },
  { title: "物料名称", dataIndex: "materialName", ellipsis: true, width: 200 },
  { title: "首/返单", dataIndex: "orderType", width: 80 },
  { title: "供应商", dataIndex: "oemRaw", width: 90, render: (v: string | null) => v ?? "—" },
  { title: "下单量", dataIndex: "qty", width: 90, align: "right", render: qn },
  { title: "下单日", dataIndex: "orderDate", width: 105 },
  { title: "需求交期", dataIndex: "needDate", width: 105, render: (v: string | null) => v ?? "—" },
  { title: "回复交期", dataIndex: "replyDate", width: 105, render: (v: string | null) => v ?? "—" },
  { title: "跟进人", dataIndex: "follower", width: 80, render: (v: string | null) => v ?? "—" },
  { title: "异常", dataIndex: "exception", ellipsis: true, width: 160, render: (v: string | null) => v ?? "—" },
];

const stockCols: ColumnsType<Row> = [
  { title: "品牌", dataIndex: "brandRaw", width: 110 },
  skuCol,
  { title: "物料编码", dataIndex: "materialCode", width: 150 },
  { title: "物料名称", dataIndex: "materialName", ellipsis: true, width: 200 },
  { title: "审批单号", dataIndex: "approvalNo", width: 140 },
  { title: "备货量", dataIndex: "qty", width: 90, align: "right", render: qn },
  { title: "已使用", dataIndex: "usedQty", width: 90, align: "right", render: qn },
  {
    title: "剩余",
    dataIndex: "remainQty",
    width: 90,
    align: "right",
    render: (v: string | null) => (v && Number(v) > 0 ? <Tag color="orange">{formatQty(v)}</Tag> : qn(v)),
  },
  { title: "备货部门", dataIndex: "follower", width: 100, render: (v: string | null) => v ?? "—" },
  { title: "成品使用时间", dataIndex: "expectDate", width: 115, render: (v: string | null) => v ?? "—" },
];

const oemCols: ColumnsType<Row> = [
  skuCol,
  { title: "成品名称", dataIndex: "materialName", ellipsis: true, width: 260 },
  { title: "加工厂", dataIndex: "oemRaw", width: 100, render: (v: string | null) => <Tag>{v}</Tag> },
  { title: "生效起", dataIndex: "startDate", width: 110, render: (v: string | null) => v ?? "—" },
  { title: "生效止", dataIndex: "expectDate", width: 110, render: (v: string | null) => (v && v.startsWith("2099") ? "长期" : v ?? "长期") },
];

export default function TransitClient() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        在途参考
      </Typography.Title>
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="口径（D16 新旧划断）：存量在途订单在旧流程收尾，本页为只读登记参考——不入实时账本；新单请走系统内 备货申请→委外工单 链路。数据来自「在途进度表」重导，整类替换。"
      />
      <Tabs
        defaultActiveKey="fg_order"
        items={[
          { key: "fg_order", label: "成品在途", children: <KindTable kind="fg_order" prefix="fg" columns={fgCols} /> },
          { key: "pkg_order", label: "包材在途", children: <KindTable kind="pkg_order" prefix="pkgo" columns={pkgCols} /> },
          { key: "pkg_stock", label: "包材备料", children: <KindTable kind="pkg_stock" prefix="pkgs" columns={stockCols} /> },
          { key: "oem_map", label: "OEM 归属", children: <KindTable kind="oem_map" prefix="oem" columns={oemCols} /> },
        ]}
      />
    </div>
  );
}
