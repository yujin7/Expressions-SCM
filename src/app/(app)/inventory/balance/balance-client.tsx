"use client";

import { useLatestRead } from "@/components/useLatestRead";

import SearchInput from "@/components/SearchInput";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert, App, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import ExportButton from "@/components/ExportButton";
import RemoteSelect from "@/components/RemoteSelect";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { COMMERCIAL_ROLE_LABELS, toOptions, WAREHOUSE_KIND_LABELS } from "@/components/labels";

interface BalanceRow {
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  commercialRole: string;
  spuCode: string;
  spuNameCn: string;
  warehouseId: number;
  warehouseName: string;
  warehouseKind: string;
  batchId: number | null;
  qty: string;
}

interface SpuBalanceRow {
  spuId: number;
  spuCode: string;
  spuNameCn: string;
  totalQty: string;
  skuCount: number;
}

const KIND_COLORS: Record<string, string> = {
  finished: "blue",
  raw: "green",
  packaging: "orange",
  outsource: "purple",
  transit: "cyan",
  snapshot: "default",
};

function SkuBalanceTab() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL（?q= 驾驶舱风险表点击直达 RT4 UX-P1-3），密度与已保存视图存本地
  const listState = useListState({
    key: "balance",
    defaults: { q: "", warehouseId: "", includeZero: "", commercialRole: "" },
    defaultPageSize: 20,
  });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const warehouseId = filters.warehouseId ? Number(filters.warehouseId) : undefined;
  const includeZero = filters.includeZero === "1";
  const commercialRole = filters.commercialRole;

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q,
        nonzero: includeZero ? "0" : "1",
        page: String(page),
        pageSize: String(pageSize),
      });
      if (warehouseId != null) params.set("warehouseId", String(warehouseId));
      if (commercialRole) params.set("commercialRole", commercialRole);
      const res = await fetchJson<{ rows: BalanceRow[]; total: number }>(
        `/api/inventory/balance?${params.toString()}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      message.error((e as Error).message);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, q, warehouseId, includeZero, commercialRole, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<BalanceRow> = [
    { title: "编码", dataIndex: "skuCode", width: 110 },
    { title: "名称", dataIndex: "skuName", width: 180 },
    {
      // 0727 会议：小样要能单独查库存明细。此前能筛小样的地方没有数量，有数量的地方没有用途。
      title: "业务用途",
      dataIndex: "commercialRole",
      width: 96,
      render: (v: string) => (
        <Tag color={v === "sample" ? "purple" : v === "unclassified" ? "warning" : undefined}>
          {COMMERCIAL_ROLE_LABELS[v] ?? v}
        </Tag>
      ),
    },
    { title: "所属产品", dataIndex: "spuNameCn", render: (_, r) => `${r.spuCode} ${r.spuNameCn}` },
    { title: "仓库", dataIndex: "warehouseName", width: 140 },
    {
      title: "仓库类型",
      dataIndex: "warehouseKind",
      width: 100,
      render: (v: string) => <Tag color={KIND_COLORS[v]}>{WAREHOUSE_KIND_LABELS[v] ?? v}</Tag>,
    },
    {
      title: "数量",
      dataIndex: "qty",
      width: 120,
      align: "right",
      render: (v: string, r) =>
        r.warehouseKind === "outsource" && Number(v) < 0 ? (
          <Tooltip title="加工厂垫料">
            <Typography.Text type="danger">{formatQty(v)}</Typography.Text>
          </Tooltip>
        ) : (
          formatQty(v)
        ),
    },
    { title: "基础单位", dataIndex: "baseUom", width: 90 },
  ];

  return (
    <div>
      <ListToolbar
        state={listState}
        primaryActions={
          <ExportButton
            href={`/api/export/balance?${new URLSearchParams({
              q,
              nonzero: includeZero ? "0" : "1",
              ...(warehouseId != null ? { warehouseId: String(warehouseId) } : {}),
              ...(commercialRole ? { commercialRole } : {}),
            }).toString()}`}
          />
        }
        extra={
          <>
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索 SKU 编码/名称"
              style={{ width: 260 }}
              onSearch={(value) => listState.setFilter({ q: value.trim() })}
            />
            <RemoteSelect
              api="/api/master/warehouse"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              filterRow={(r) => r.accountingMode === "realtime"}
              allowClear
              placeholder="全部实时仓（快照仓请切「全仓视图」页签）"
              style={{ width: 280 }}
              value={warehouseId}
              onChange={(v) => listState.setFilter({ warehouseId: v == null ? "" : String(v) })}
            />
            <Select
              allowClear
              value={commercialRole || undefined}
              placeholder="全部业务用途"
              options={toOptions(COMMERCIAL_ROLE_LABELS)}
              style={{ width: 150 }}
              onChange={(v) => listState.setFilter({ commercialRole: v ?? "" })}
            />
            <Space size={8}>
              <Switch
                checked={includeZero}
                onChange={(v) => listState.setFilter({ includeZero: v ? "1" : "" })}
              />
              <Typography.Text>含零库存</Typography.Text>
            </Space>
          </>
        }
      />
      <Table<BalanceRow>
        rowKey={(r) => `${r.skuId}-${r.warehouseId}-${r.batchId ?? "nb"}`}
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        scroll={{ x: "max-content" }}
        summary={(pageData) => {
          // UX 走查 #6：Excel 肌肉记忆——本页合计行（跨单位直加仅作参考）
          const sum = pageData.reduce((acc, r) => acc + Number(r.qty || 0), 0);
          return (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={columns.length - 2}>
                本页合计（{pageData.length} 行，跨单位直加仅参考）
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                {sum.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} />
            </Table.Summary.Row>
          );
        }}
        loading={loading}
        pagination={listState.paginationProps({ total: total })}
      />
    </div>
  );
}

function SpuBalanceTab() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<SpuBalanceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState("");

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    try {
      const res = await fetchJson<{ rows: SpuBalanceRow[]; total: number }>(
        `/api/inventory/balance/spu?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      message.error((e as Error).message);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, q, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<SpuBalanceRow> = [
    { title: "产品编码", dataIndex: "spuCode", width: 140 },
    { title: "产品名", dataIndex: "spuNameCn" },
    { title: "SKU 数", dataIndex: "skuCount", width: 100, align: "right" },
    { title: "合计数量", dataIndex: "totalQty", width: 140, align: "right", render: (v: string) => formatQty(v) },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="SPU 汇总按数量直加，仅同基础单位产品有参考意义（R3）"
      />
      <Space style={{ marginBottom: 16 }} wrap>
        <SearchInput
          allowClear
          placeholder="搜索产品编码/名称"
          style={{ width: 260 }}
          onSearch={(value) => {
            setQ(value.trim());
            setPage(1);
          }}
        />
      </Space>
      <Table<SpuBalanceRow>
        rowKey="spuId"
        size="middle"
        columns={columns}
        dataSource={rows}
        scroll={{ x: "max-content" }}
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
    </div>
  );
}

interface SnapshotRow {
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  /** 业务用途（0727：小样单独查库存）——由 listSnapshotBalances 下发；此前列有渲染、服务端从未 select，永远空白 */
  commercialRole: string;
  spuCode: string;
  spuNameCn: string;
  warehouseId: number;
  warehouseName: string;
  qty: string;
  bizDate: string;
}

/** D20 全仓视图：快照仓最新库存（只读参考口径，带数据龄标注，不入账本） */
function SnapshotTab() {
  const { message } = App.useApp();
  const initialQ = useSearchParams().get("q") ?? "";
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState(initialQ);
  const [warehouseId, setWarehouseId] = useState<number | undefined>();

  const beginLoadRead = useLatestRead();
  const load = useCallback(async () => {
    const readRequest = beginLoadRead();
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (warehouseId != null) params.set("warehouseId", String(warehouseId));
      const res = await fetchJson<{ rows: SnapshotRow[]; total: number }>(
        `/api/inventory/balance/snapshot?${params.toString()}`, { signal: readRequest.signal });
      if (!readRequest.isCurrent()) return;
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      if (!readRequest.isCurrent()) return;
      message.error((e as Error).message);
    } finally {
      if (readRequest.isCurrent()) { setLoading(false); }
    }
  }, [beginLoadRead, q, warehouseId, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const ageDays = (bizDate: string) =>
    Math.max(0, Math.floor((Date.now() - new Date(`${bizDate}T00:00:00+08:00`).getTime()) / 86_400_000));

  const columns: ColumnsType<SnapshotRow> = [
    { title: "编码", dataIndex: "skuCode", width: 110 },
    { title: "名称", dataIndex: "skuName", width: 180 },
    {
      // 0727 会议：小样要能单独查库存明细。此前能筛小样的地方没有数量，有数量的地方没有用途。
      title: "业务用途",
      dataIndex: "commercialRole",
      width: 96,
      render: (v: string) => (
        <Tag color={v === "sample" ? "purple" : v === "unclassified" ? "warning" : undefined}>
          {COMMERCIAL_ROLE_LABELS[v] ?? v}
        </Tag>
      ),
    },
    { title: "所属产品", dataIndex: "spuNameCn", render: (_, r) => `${r.spuCode} ${r.spuNameCn}` },
    { title: "仓库", dataIndex: "warehouseName", width: 160 },
    { title: "数量", dataIndex: "qty", width: 120, align: "right", render: (v: string) => formatQty(v) },
    { title: "基础单位", dataIndex: "baseUom", width: 90 },
    {
      title: "数据日期",
      dataIndex: "bizDate",
      width: 150,
      render: (v: string) => {
        const d = ageDays(v);
        return (
          <Space size={6}>
            {v}
            <Tag color={d <= 1 ? "green" : d <= 3 ? "orange" : "red"}>{d === 0 ? "今日" : `${d} 天前`}</Tag>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="快照仓（保税/云/平台仓）只读参考口径：数据来自快照导入，不入实时账本；留意「数据日期」标签判断新鲜度（D20）"
      />
      <Space style={{ marginBottom: 16 }} wrap>
        <SearchInput
          allowClear
          defaultValue={initialQ}
          placeholder="搜索 SKU 编码/名称"
          style={{ width: 260 }}
          onSearch={(value) => {
            setQ(value.trim());
            setPage(1);
          }}
        />
        <RemoteSelect
          api="/api/master/warehouse"
          getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
          filterRow={(r) => r.accountingMode === "snapshot"}
          allowClear
          placeholder="全部快照仓"
          style={{ width: 220 }}
          value={warehouseId}
          onChange={(v) => {
            setWarehouseId(v as number | undefined);
            setPage(1);
          }}
        />
      </Space>
      <Table<SnapshotRow>
        rowKey={(r) => `${r.skuId}-${r.warehouseId}`}
        size="middle"
        columns={columns}
        dataSource={rows}
        scroll={{ x: "max-content" }}
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
    </div>
  );
}

export default function BalanceClient() {
  return (
    <Suspense>
      <BalanceInner />
    </Suspense>
  );
}

function BalanceInner() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        库存余额
      </Typography.Title>
      <Tabs
        defaultActiveKey="sku"
        items={[
          { key: "sku", label: "SKU 明细", children: <SkuBalanceTab /> },
          { key: "spu", label: "SPU 汇总", children: <SpuBalanceTab /> },
          { key: "snapshot", label: "全仓视图（快照）", children: <SnapshotTab /> },
        ]}
      />
    </div>
  );
}
