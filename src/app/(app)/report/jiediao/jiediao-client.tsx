"use client";

/**
 * R16 借调对账：月度部门间借调矩阵 + 明细 + 净借入/借出签字页。
 * 数据源=完成态调拨单（reason='借调'）；替代 借入/借出 手工透视表。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Card, Col, DatePicker, Empty, Row, Skeleton, Space, Table, Tag, Typography } from "antd";
import { PrinterOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { fetchJson } from "@/components/fetchJson";
import type { JiediaoReport } from "@/server/modules/report/jiediao";

const fmt = (v: number | string): string => Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 4 });

export default function JiediaoClient() {
  const { message } = App.useApp();
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [data, setData] = useState<JiediaoReport | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <div>
      <Space align="baseline" style={{ justifyContent: "space-between", width: "100%", marginBottom: 8 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          借调对账（R16）
        </Typography.Title>
        <Space className="no-print">
          <DatePicker picker="month" value={month} allowClear={false} onChange={(v) => v && setMonth(v)} />
          <a onClick={() => void load()}>
            <ReloadOutlined /> 刷新
          </a>
          <a onClick={() => window.print()}>
            <PrinterOutlined /> 打印签字页
          </a>
        </Space>
      </Space>
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
              size="small"
              columns={lineCols}
              dataSource={data.lines}
              pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
              scroll={{ x: "max-content" }}
            />
          </Card>
        </>
      )}
    </div>
  );
}
