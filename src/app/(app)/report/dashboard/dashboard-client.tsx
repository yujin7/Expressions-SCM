"use client";

/**
 * 经营驾驶舱：销量 / 库存 / 效期 / 可销天数 / 委外执行 / 数据健康 一屏总览。
 * 口径提示常驻：数量跨 SKU 直加仅参考；快照仓带数据日期；金额仅限授权角色。
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Card,
  Col,
  Empty,
  Row,
  Segmented,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip as AntTooltip,
  Typography,
} from "antd";
import {
  AlertOutlined,
  BulbOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  FallOutlined,
  ReloadOutlined,
  RiseOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  ComposedChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchJson } from "@/components/fetchJson";
import type { DashboardData } from "@/server/modules/report/dashboard";

const PALETTE = ["#2f54eb", "#13c2c2", "#fa8c16", "#722ed1", "#52c41a", "#eb2f96", "#a0d911", "#1677ff", "#f5222d", "#faad14"];
const EXP_COLORS: Record<string, string> = {
  已到期: "#cf1322",
  "0-3月": "#fa541c",
  "3-6月": "#fa8c16",
  "6-12月": "#fadb14",
  "12-18月": "#d3f261",
  "18-24月": "#a0d911",
  ">24月": "#52c41a",
};
const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  pending: "待审批",
  approved: "已审批",
  in_progress: "执行中",
  completed: "已完成",
  rejected: "已驳回",
  cancelled: "已作废",
  reversed: "已冲销",
};
const STATUS_COLORS: Record<string, string> = {
  draft: "#d9d9d9",
  pending: "#faad14",
  approved: "#1677ff",
  in_progress: "#13c2c2",
  completed: "#52c41a",
  rejected: "#ff4d4f",
  cancelled: "#8c8c8c",
  reversed: "#722ed1",
};

/** 试销打标（CURRENT.md 词汇表承诺：试销=新品观察期，报表打标） */
const LifeTag = ({ v }: { v?: string }) =>
  v === "trial" ? <Tag color="purple">试销</Tag> : v === "halted" ? <Tag>停售</Tag> : v === "retired" ? <Tag color="default">淘汰</Tag> : null;

const fmt = (v: number | string | undefined | null): string =>
  v == null ? "—" : Number(v).toLocaleString("zh-CN");

function ChartCard({ title, extra, height = 300, children }: { title: React.ReactNode; extra?: React.ReactNode; height?: number; children: React.ReactNode }) {
  return (
    <Card size="small" title={title} extra={extra} styles={{ body: { height } }}>
      {children}
    </Card>
  );
}

export default function DashboardClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [trendMode, setTrendMode] = useState<string | number>("按品牌");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchJson<DashboardData>("/api/report/dashboard"));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <Skeleton active paragraph={{ rows: 12 }} />;
  if (!data) return <Empty description="驾驶舱数据加载失败" />;

  const { kpi } = data;
  const channelTotal = data.channelMix.reduce((a, c) => a + c.qty, 0);

  const riskCols: ColumnsType<DashboardData["expiryRiskTop"][number]> = [
    { title: "编码", dataIndex: "code", width: 130, render: (v: string, r) => <><a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a><LifeTag v={(r as { lifecycle?: string }).lifecycle} /></> },
    { title: "名称", dataIndex: "name", ellipsis: true },
    { title: "仓库", dataIndex: "warehouse", width: 110, ellipsis: true },
    {
      title: "剩余",
      dataIndex: "daysLeft",
      width: 90,
      align: "right",
      render: (v: number) => <Tag color={v < 0 ? "red" : v < 92 ? "volcano" : "orange"}>{v < 0 ? `逾期${-v}天` : `${v}天`}</Tag>,
    },
    { title: "数量", dataIndex: "qty", width: 90, align: "right", render: fmt },
  ];

  const slowCols: ColumnsType<DashboardData["slowTop"][number]> = [
    { title: "编码", dataIndex: "code", width: 130, render: (v: string, r) => <><a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a><LifeTag v={(r as { lifecycle?: string }).lifecycle} /></> },
    { title: "名称", dataIndex: "name", ellipsis: true },
    { title: "在库", dataIndex: "onHand", width: 90, align: "right", render: fmt },
    { title: "近3月销", dataIndex: "sales3m", width: 90, align: "right", render: fmt },
    {
      title: "可销天数",
      dataIndex: "daysCover",
      width: 100,
      align: "right",
      render: (v: number | null) => (v == null ? <Tag color="red">无动销</Tag> : <Tag color="orange">{fmt(v)}天</Tag>),
    },
  ];

  return (
    <div>
      <Space align="baseline" style={{ justifyContent: "space-between", width: "100%", marginBottom: 8 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          经营驾驶舱
        </Typography.Title>
        <Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            数量为跨 SKU 直加参考口径；快照仓数据日期 {kpi.snapDate ?? "—"}
          </Typography.Text>
          <a onClick={() => void load()}>
            <ReloadOutlined /> 刷新
          </a>
        </Space>
      </Space>

      {/* KPI 行 */}
      <Row gutter={[12, 12]}>
        <Col xs={12} md={8} xl={3}>
          <Card size="small">
            <Statistic title="在用 SKU / SPU" value={kpi.skuActive} suffix={`/ ${kpi.spuCount}`} prefix={<DatabaseOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={3}>
          <Card size="small">
            <Statistic title={`${kpi.lastMonth ?? "—"} 全渠道销量`} value={kpi.salesLastMonth} prefix={<RiseOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={3}>
          <Card size="small">
            <AntTooltip title="全部实时记账仓合计：自有仓（1仓2仓）+成品/原料/包材仓+委外仓（垫料为负）——与下方「库存分布」逐仓条形图同源">
              <Statistic title="实时账在库（全部记账仓）" value={kpi.ownStockQty} />
            </AntTooltip>
          </Card>
        </Col>
        <Col xs={12} md={8} xl={3}>
          <Card size="small">
            <AntTooltip title={`快照仓最新快照合计（${kpi.snapDate ?? "—"}）`}>
              <Statistic title="快照仓参考" value={kpi.snapStockQty} />
            </AntTooltip>
          </Card>
        </Col>
        <Col xs={12} md={8} xl={3}>
          <Card size="small">
            <Statistic
              title="效期风险量（≤6月）"
              value={kpi.expiryRiskQty}
              valueStyle={{ color: kpi.expiryRiskQty > 0 ? "#cf1322" : undefined }}
              prefix={<ClockCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={3}>
          <Card size="small">
            <a href="/report/risk" style={{ color: "inherit" }}>
              <AntTooltip title="风险库存处置工作台条目（效期×货盘注记×销速三源）——点击进入">
                <Statistic
                  title="风险处置 SKU"
                  value={kpi.riskActionCount}
                  valueStyle={{ color: kpi.riskActionCount > 0 ? "#cf1322" : undefined }}
                  prefix={<ClockCircleOutlined />}
                />
              </AntTooltip>
            </a>
          </Card>
        </Col>
        <Col xs={12} md={8} xl={3}>
          <Card size="small">
            <a href="/workbench" style={{ color: "inherit" }}>
              <AntTooltip title="滞销 SKU 数 / 待办（待审批+数据积压）——点击进工作台处理">
                <Statistic
                  title="滞销 SKU / 待办"
                  value={kpi.slowMoverCount}
                  suffix={`/ ${kpi.pendingApprovals + kpi.reviewBacklog}`}
                  valueStyle={{ color: kpi.slowMoverCount > 0 ? "#fa8c16" : undefined }}
                  prefix={<FallOutlined />}
                />
              </AntTooltip>
            </a>
          </Card>
        </Col>
      </Row>

      {/* 智能洞察 */}
      {data.insights.length > 0 && (
        <Alert
          style={{ marginTop: 12 }}
          type="info"
          showIcon
          icon={<BulbOutlined />}
          message="智能洞察（纯报表口径自动归纳，不代决策）"
          description={
            <>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {data.insights.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <Space size={16} style={{ marginTop: 8 }}>
                <a href="/workbench">→ 工作台待办</a>
                <a href="/import/release">→ 放行工作台</a>
                <a href="/import/exceptions">→ 别名认领</a>
                <a href="/inventory/balance">→ 库存余额</a>
              </Space>
            </>
          }
        />
      )}

      {/* 销售趋势 + 渠道结构 */}
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={16}>
          <ChartCard
            title={`销售趋势（${data.salesWindow.months6[0] ?? ""} ~ ${data.salesWindow.months6.at(-1) ?? ""}，全渠道）`}
            extra={<Segmented size="small" options={["按品牌", "总量"]} value={trendMode} onChange={setTrendMode} />}
          >
            <ResponsiveContainer>
              <ComposedChart data={data.salesTrend} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <Tooltip formatter={(v) => fmt(v as number)} />
                <Legend />
                {trendMode === "按品牌" ? (
                  data.trendBrands.map((b, i) => <Bar key={b} dataKey={b} stackId="s" fill={PALETTE[i % PALETTE.length]} />)
                ) : (
                  <Bar dataKey="total" name="总量" fill="#2f54eb" />
                )}
                <Line type="monotone" dataKey="total" name="合计" stroke="#f5222d" strokeWidth={2} dot />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
        </Col>
        <Col xs={24} xl={8}>
          <ChartCard title={`渠道结构（近${data.salesWindow.months6.length}个月）`}>
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={data.channelMix}
                  dataKey="qty"
                  nameKey="name"
                  innerRadius="45%"
                  outerRadius="72%"
                  paddingAngle={2}
                  label={(p) => {
                    const share = channelTotal ? Math.round(((p.value as number) / channelTotal) * 100) : 0;
                    return share >= 5 ? `${p.name} ${share}%` : "";
                  }}
                >
                  {data.channelMix.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => fmt(v as number)} />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
        </Col>
      </Row>

      {/* 品牌 + TOP SKU */}
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={8}>
          <ChartCard title={`品牌销量结构（近${data.salesWindow.months6.length}个月）`}>
            <ResponsiveContainer>
              <BarChart data={data.brandSales} layout="vertical" margin={{ left: 24, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <YAxis type="category" dataKey="name" width={88} />
                <Tooltip formatter={(v) => fmt(v as number)} />
                <Bar dataKey="qty" name="销量">
                  {data.brandSales.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Col>
        <Col xs={24} xl={16}>
          <ChartCard title={`TOP 10 SKU（近${data.salesWindow.months6.length}个月销量）`}>
            <ResponsiveContainer>
              <BarChart data={data.topSkus} layout="vertical" margin={{ left: 24, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <YAxis type="category" dataKey="code" width={100} />
                <Tooltip
                  formatter={(v) => fmt(v as number)}
                  labelFormatter={(label) => {
                    const r = data.topSkus.find((x) => x.code === label);
                    return r ? `${r.code} ${r.name}` : String(label);
                  }}
                />
                <Bar dataKey="qty" name="销量" fill="#13c2c2" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Col>
      </Row>

      {/* 库存分布 + 可销天数 */}
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={14}>
          <ChartCard
            title="库存分布（TOP 仓库）"
            extra={
              <Space size={4}>
                <Tag color="blue">实时账</Tag>
                <Tag>快照参考</Tag>
              </Space>
            }
          >
            <ResponsiveContainer>
              <BarChart data={data.warehouseStock} margin={{ bottom: 48, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" interval={0} angle={-30} textAnchor="end" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <Tooltip
                  formatter={(v) => fmt(v as number)}
                  labelFormatter={(label) => {
                    const r = data.warehouseStock.find((x) => x.name === label);
                    return r?.mode === "snapshot" ? `${label}（快照 ${r.bizDate}）` : `${label}（实时账）`;
                  }}
                />
                <Bar dataKey="qty" name="在库量">
                  {data.warehouseStock.map((r, i) => (
                    <Cell key={i} fill={r.mode === "realtime" ? "#2f54eb" : "#bfbfbf"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Col>
        <Col xs={24} xl={10}>
          <ChartCard title="可销天数分布（全网口径 = 实时账 + 最新快照）">
            <ResponsiveContainer>
              <BarChart data={data.coverBuckets} margin={{ right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" name="SKU 数">
                  {data.coverBuckets.map((r, i) => (
                    <Cell
                      key={i}
                      fill={r.bucket === "<30天" ? "#fa541c" : r.bucket === ">180天" || r.bucket === "无动销" ? "#faad14" : "#52c41a"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Col>
      </Row>

      {/* 效期 */}
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={10}>
          <ChartCard title="效期七段位（批次参考层）">
            <ResponsiveContainer>
              <BarChart data={data.expiryBuckets} margin={{ right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : String(v))} />
                <Tooltip formatter={(v, n) => [fmt(v as number), n === "qty" ? "数量" : n]} />
                <Bar dataKey="qty" name="数量">
                  {data.expiryBuckets.map((r, i) => (
                    <Cell key={i} fill={EXP_COLORS[r.bucket] ?? "#8c8c8c"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Col>
        <Col xs={24} xl={14}>
          <Card
            size="small"
            title={
              <Space>
                <AlertOutlined style={{ color: "#cf1322" }} />
                近效期风险 TOP 10（≤6 月）
              </Space>
            }
          >
            <Table<DashboardData["expiryRiskTop"][number]>
              rowKey={(r) => `${r.code}-${r.warehouse}-${r.expiryDate}-${data.expiryRiskTop.indexOf(r)}`}
              size="small"
              columns={riskCols}
              dataSource={data.expiryRiskTop}
              pagination={false}
              locale={{ emptyText: "无 180 天内到期批次" }}
            />
          </Card>
        </Col>
      </Row>

      {/* 滞销 + 委外执行 */}
      <Row gutter={[12, 12]} style={{ marginTop: 12, marginBottom: 12 }}>
        <Col xs={24} xl={14}>
          <Card size="small" title="滞销压库 TOP 10（可销天数 > 180 或无动销，按在库量排序）">
            <Table<DashboardData["slowTop"][number]>
              rowKey="code"
              size="small"
              columns={slowCols}
              dataSource={data.slowTop}
              pagination={false}
              locale={{ emptyText: "无滞销 SKU" }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card size="small" title="委外执行 / 数据健康" styles={{ body: { paddingTop: 8 } }}>
            {data.outsource.map((d) => (
              <div key={d.docType} style={{ marginBottom: 8 }}>
                <Typography.Text style={{ fontSize: 12 }}>
                  {d.label}（{d.total}）
                </Typography.Text>
                <div style={{ display: "flex", gap: 2, marginTop: 2 }}>
                  {d.total === 0 ? (
                    <div style={{ flex: 1, height: 10, background: "#f0f0f0", borderRadius: 4 }} />
                  ) : (
                    Object.entries(d.byStatus).map(([st, c]) => (
                      <AntTooltip key={st} title={`${STATUS_LABELS[st] ?? st}: ${c}`}>
                        <div
                          style={{
                            flex: c,
                            height: 10,
                            background: STATUS_COLORS[st] ?? "#d9d9d9",
                            borderRadius: 4,
                            minWidth: 6,
                          }}
                        />
                      </AntTooltip>
                    ))
                  )}
                </div>
              </div>
            ))}
            <Space direction="vertical" size={4} style={{ marginTop: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                待审批 {kpi.pendingApprovals} · 别名/导入待处理 {kpi.reviewBacklog}
              </Typography.Text>
              {data.settlement && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  结算单 {data.settlement.docs} 张，累计净额 ¥{fmt(data.settlement.amountSum)}（仅财务/管理员可见）
                </Typography.Text>
              )}
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
