"use client";

import SearchInput from "@/components/SearchInput";

/**
 * R16 借调对账：月度部门间借调矩阵 + 明细 + 净借入/借出签字页。
 * 数据源=完成态调拨单（reason='借调'）；替代 借入/借出 手工透视表。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Card, Col, DatePicker, Empty, Row, Skeleton, Table, Tabs, Tag, Typography } from "antd";
import { PrinterOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import type { JiediaoReport } from "@/server/modules/report/jiediao";

const fmt = (v: number | string): string => Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 4 });

interface BorrowRow {
  id: number;
  skuCode: string | null;
  orderType: string | null; // 借入/借出
  qty: string | null;
  follower: string | null; // 对方部门
  progress: string | null; // YYYY-MM
}

/** 历史借调（R16 上线前，文件导入登记）——衔接系统对账的前史 */
function BorrowHistoryTab() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<BorrowRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 本页签独立列表状态：URL 参数命名空间 hist_*（与「系统对账」页签互不干扰）
  const listState = useListState({
    key: "jiediao-borrow",
    paramPrefix: "hist",
    defaults: { q: "" },
    defaultPageSize: 20,
  });
  const { page, pageSize } = listState;
  const q = listState.filters.q;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ kind: "borrow", q, page: String(page), pageSize: String(pageSize) });
      const res = await fetchJson<{ rows: BorrowRow[]; total: number }>(`/api/report/transit?${params.toString()}`);
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const cols: ColumnsType<BorrowRow> = [
    { title: "月份", dataIndex: "progress", width: 90 },
    { title: "编码", dataIndex: "skuCode", width: 130, render: (v: string | null) => (v ? <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a> : "—") },
    { title: "方向", dataIndex: "orderType", width: 80, render: (v: string | null) => <Tag color={v === "借入" ? "orange" : "blue"}>{v}</Tag> },
    { title: "对方部门", dataIndex: "follower", width: 140 },
    { title: "数量", dataIndex: "qty", width: 100, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
  ];

  return (
    <div>
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="系统上线前的借调记录（「需求&计划&达成统计表」借入/借出页导入，只读登记）；上线后的借调走调拨单（原因=借调），见「系统对账」页签。"
      />
      <ListToolbar
        state={listState}
        extra={
          <SearchInput
            key={q}
            allowClear
            defaultValue={q}
            placeholder="搜索编码"
            style={{ width: 220 }}
            onSearch={(v) => listState.setFilter({ q: v.trim() })}
          />
        }
      />
      <Table<BorrowRow>
        rowKey="id"
        size={listState.tableSize}
        columns={cols}
        dataSource={rows}
        loading={loading}
        pagination={listState.paginationProps({ total: total })}
      />
    </div>
  );
}

export default function JiediaoClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<JiediaoReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false); // 打印时明细全量渲染（RT4 UX-P1-6：签字凭据不能只打当前页）
  // 本页签独立列表状态：URL 参数命名空间 sys_*（与「历史导入」页签互不干扰）；月份空=当月
  const listState = useListState({
    key: "jiediao-sys",
    paramPrefix: "sys",
    defaults: { month: "" },
    defaultPageSize: 20,
  });
  const monthParam = listState.filters.month;
  const month: Dayjs = useMemo(() => {
    const d = dayjs(monthParam);
    return monthParam && d.isValid() ? d : dayjs();
  }, [monthParam]);

  const handlePrint = () => {
    setPrinting(true);
    setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 60);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchJson<JiediaoReport>(`/api/report/jiediao?month=${month.format("YYYY-MM")}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [month, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const matrixCols: ColumnsType<JiediaoReport["matrix"][number]> = [
    { title: "借出仓（部门）", dataIndex: "fromWarehouse" },
    { title: "借入仓（部门）", dataIndex: "toWarehouse" },
    { title: "单据数", dataIndex: "docCount", width: 90, align: "right" },
    { title: "合计数量", dataIndex: "totalQty", width: 120, align: "right", render: fmt },
  ];

  const netCols: ColumnsType<JiediaoReport["netByWarehouse"][number]> = [
    { title: "仓库（部门）", dataIndex: "warehouse" },
    { title: "借入", dataIndex: "borrowedIn", width: 110, align: "right", render: fmt },
    { title: "借出", dataIndex: "lentOut", width: 110, align: "right", render: fmt },
    {
      title: "净额（+借入/−借出）",
      dataIndex: "net",
      width: 160,
      align: "right",
      render: (v: number) => <Tag color={v > 0 ? "orange" : v < 0 ? "blue" : "default"}>{v > 0 ? "+" : ""}{fmt(v)}</Tag>,
    },
  ];

  const lineCols: ColumnsType<JiediaoReport["lines"][number]> = [
    { title: "单号", dataIndex: "docNo", width: 150 },
    { title: "过账日", dataIndex: "postedAt", width: 110 },
    { title: "借出仓", dataIndex: "fromWarehouse", width: 140, ellipsis: true },
    { title: "借入仓", dataIndex: "toWarehouse", width: 140, ellipsis: true },
    { title: "编码", dataIndex: "skuCode", width: 110 },
    { title: "名称", dataIndex: "skuName", ellipsis: true },
    { title: "数量", dataIndex: "qty", width: 100, align: "right", render: fmt },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    { title: "备注", dataIndex: "remark", width: 140, ellipsis: true },
  ];

  const systemTab = (
    <div>
      <div className="no-print">
        <ListToolbar
          state={listState}
          extra={
            <>
              <DatePicker
                picker="month"
                value={month}
                allowClear={false}
                onChange={(v) => v && listState.setFilter({ month: v.format("YYYY-MM") })}
              />
              <a onClick={() => void load()}>
                <ReloadOutlined /> 刷新
              </a>
              <a onClick={handlePrint}>
                <PrinterOutlined /> 打印签字页（含全量明细）
              </a>
            </>
          }
        />
      </div>
      <style>{`@media print { .no-print, .ant-layout-sider, .ant-layout-header { display: none !important; } }`}</style>
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="口径：借调 = 完成态调拨单且业务原因=「借调」；月份按过账时间归属；数量跨 SKU 直加仅作对账参考。"
      />
      {loading && !data ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : !data ? (
        <Empty />
      ) : data.lines.length === 0 ? (
        <Empty description={`${data.month} 无借调记录（在库存单据新建调拨时选择业务原因「借调」即计入本表）`} />
      ) : (
        <>
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={12}>
              <Card size="small" title={`借调矩阵（${data.month}）`}>
                <Table rowKey={(r) => `${r.fromWarehouse}-${r.toWarehouse}`} size="small" columns={matrixCols} dataSource={data.matrix} pagination={false} />
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card size="small" title="按仓净额（对账签字依据）">
                <Table rowKey="warehouse" size="small" columns={netCols} dataSource={data.netByWarehouse} pagination={false} />
                <div style={{ marginTop: 24, display: "flex", gap: 48 }}>
                  <span>借出方签字：____________</span>
                  <span>借入方签字：____________</span>
                  <span>日期：____________</span>
                </div>
              </Card>
            </Col>
          </Row>
          <Card size="small" title={`明细（${data.lines.length} 行）`} style={{ marginTop: 12, marginBottom: 12 }}>
            <Table
              rowKey={(r) => `${r.docNo}-${r.skuCode}-${r.fromWarehouse}`}
              size={listState.tableSize}
              columns={lineCols}
              dataSource={data.lines}
              pagination={
                printing
                  ? false
                  : {
                      current: listState.page,
                      pageSize: listState.pageSize,
                      showSizeChanger: true,
                      showTotal: (t) => `共 ${t} 条`,
                      onChange: (p, ps) => listState.setPage(p, ps),
                    }
              }
              scroll={{ x: "max-content" }}
            />
          </Card>
        </>
      )}
    </div>
  );

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        借调对账（R16）
      </Typography.Title>
      <Tabs
        defaultActiveKey="sys"
        items={[
          { key: "sys", label: "系统对账", children: systemTab },
          { key: "hist", label: "历史导入", children: <BorrowHistoryTab /> },
        ]}
      />
    </div>
  );
}
