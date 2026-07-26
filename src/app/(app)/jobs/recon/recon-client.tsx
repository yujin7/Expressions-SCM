"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlayCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { hasAnyRole, useMe } from "@/components/useMe";

interface ReconDiffRow {
  id: number;
  bizDate: string;
  skuId: number;
  skuCode: string;
  skuName: string;
  sysQty: string;
  jstQty: string;
  diffQty: string;
  status: "open" | "explained" | "resolved";
  note: string | null;
}

interface ReconSummary {
  bizDate: string;
  skuCount: number;
  matchedCount: number;
  diffCount: number;
  sysOnly: number;
  unresolvedRows: number;
  maxAbsDiffPct: number | null;
}

/** 差异状态（recon_status）——当前无状态流转接口，仅展示 */
const STATUS_META: Record<ReconDiffRow["status"], { color: string; label: string }> = {
  open: { color: "error", label: "待处理" },
  explained: { color: "processing", label: "已解释" },
  resolved: { color: "success", label: "一致" },
};

/** 昨日（Asia/Shanghai 自然日，与后端 shanghaiToday(-1) 同口径） */
function shanghaiYesterday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
    new Date(Date.now() - 24 * 3600 * 1000),
  );
}

export default function ReconClient() {
  const { message } = App.useApp();
  const me = useMe();
  const canRun = hasAnyRole(me, "finance", "warehouse");

  const [bizDate, setBizDate] = useState<string>(shanghaiYesterday());
  const [rows, setRows] = useState<ReconDiffRow[]>([]);
  const [summary, setSummary] = useState<ReconSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ rows: ReconDiffRow[]; summary: ReconSummary }>(
        `/api/jobs/recon?bizDate=${bizDate}`,
      );
      setRows(res.rows);
      setSummary(res.summary);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [bizDate, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    setRunning(true);
    try {
      const s = await postJson<ReconSummary>("/api/jobs/recon/run", { bizDate });
      setSummary(s); // run 返回含实时 unresolvedRows 的 summary（GET 重算口径无此值）
      message.success(
        `对账完成：${s.skuCount} 个 SKU，差异 ${s.diffCount}，未解析 ${s.unresolvedRows} 行`,
      );
      // 只刷新差异行，保留 run 返回的 summary（含 unresolvedRows 实时值）
      const res = await fetchJson<{ rows: ReconDiffRow[]; summary: ReconSummary }>(
        `/api/jobs/recon?bizDate=${bizDate}`,
      );
      setRows(res.rows);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const columns: ColumnsType<ReconDiffRow> = [
    { title: "SKU 编码", dataIndex: "skuCode", width: 140 },
    { title: "SKU 名称", dataIndex: "skuName", width: 200 },
    {
      title: "系统出库",
      dataIndex: "sysQty",
      width: 100,
      align: "right",
      render: (v: string) => formatQty(v),
    },
    {
      title: "聚水潭",
      dataIndex: "jstQty",
      width: 100,
      align: "right",
      render: (v: string) => formatQty(v),
    },
    {
      title: "差异（系统−聚水潭）",
      dataIndex: "diffQty",
      width: 150,
      align: "right",
      render: (v: string) =>
        Number(v) === 0 ? (
          <Typography.Text type="success">0</Typography.Text>
        ) : (
          <Typography.Text type="danger">{formatQty(v)}</Typography.Text>
        ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (v: ReconDiffRow["status"]) => {
        const meta = STATUS_META[v] ?? { color: "default", label: v };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    { title: "说明", dataIndex: "note", render: (v: string | null) => v ?? "—" },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        聚水潭对账差异
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        每日 SKU 级对账：系统侧=自有仓销售出库流水；聚水潭侧=当日最近一次导入的日汇总（按别名解析归并）。
      </Typography.Paragraph>

      <Space style={{ marginBottom: 16 }} wrap>
        <span>业务日期：</span>
        <DatePicker
          allowClear={false}
          value={dayjs(bizDate)}
          onChange={(d: Dayjs | null) => {
            if (d) setBizDate(d.format("YYYY-MM-DD"));
          }}
          disabledDate={(d) => d.isAfter(dayjs(), "day")}
        />
        {canRun ? (
          <Popconfirm
            title={`确认对 ${bizDate} 运行对账？重跑将幂等覆盖当日差异。`}
            okText="运行"
            cancelText="取消"
            onConfirm={() => void run()}
          >
            <Button type="primary" icon={<PlayCircleOutlined />} loading={running}>
              运行对账
            </Button>
          </Popconfirm>
        ) : null}
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>

      {summary ? (
        <Row gutter={12} style={{ marginBottom: 16 }}>
          <Col span={4}>
            <Card size="small">
              <Statistic title="SKU 数" value={summary.skuCount} />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="匹配"
                value={summary.matchedCount}
                valueStyle={{ color: "#3f8600" }}
              />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="差异"
                value={summary.diffCount}
                valueStyle={summary.diffCount > 0 ? { color: "#cf1322" } : undefined}
              />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Tooltip title="聚水潭侧 sku_code 别名未解析的行数——以最近一次「运行对账」的返回为准（查询页面不重算）">
                <Statistic
                  title="未解析"
                  value={summary.unresolvedRows}
                  valueStyle={summary.unresolvedRows > 0 ? { color: "#d46b08" } : undefined}
                />
              </Tooltip>
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Tooltip title="聚水潭=0 且系统>0 的 SKU（分母为 0，不参与最大偏差百分比）">
                <Statistic
                  title="仅系统侧"
                  value={summary.sysOnly}
                  valueStyle={summary.sysOnly > 0 ? { color: "#d46b08" } : undefined}
                />
              </Tooltip>
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="最大偏差 %"
                value={summary.maxAbsDiffPct == null ? "—" : summary.maxAbsDiffPct}
              />
            </Card>
          </Col>
        </Row>
      ) : null}

      <Table<ReconDiffRow>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{ pageSize: 50, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true }}
        locale={{
          emptyText: (
            <Empty
              description={
                <div>
                  <div>该日期暂无对账结果。</div>
                  <div style={{ marginTop: 4 }}>
                    先在<Link href="/import/jobs">导入中心</Link>
                    上传聚水潭日汇总（模板见 JST_DAILY_TEMPLATE），再运行对账。
                  </div>
                </div>
              }
            />
          ),
        }}
      />
    </div>
  );
}
