"use client";

import { Button, Card, Col, Grid, Row, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import ContextHelp from "@/components/ContextHelp";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import RemoteSelect from "@/components/RemoteSelect";
import { useDocumentRead } from "@/components/useDocumentRead";
import type { ListState } from "@/components/useListState";
import { formatQty } from "@/components/format";
import { formatOrderType } from "@/components/labels";
import DocStatusTag from "@/components/DocStatusTag";
import { AsyncExportButton } from "@/components/ExportButton";
import type { ProcessingCycleRow, ProcessingCycles as Result } from "@/server/modules/report/processing-cycle";

const link = (kind: "wo" | "jg" | "sh", no: string) => <a key={no} href={`${kind === "sh" ? "/matflow" : "/outsource"}/${kind}?q=${encodeURIComponent(no)}`}>{no}</a>;
const time = (at: string | null) => at ? new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "无证据";
const days = (value: number | null) => value === null ? "—" : `${value} 天`;

export default function ProcessingCycles({ view, url }: {
  view: ListState<{ supplierId: string; overdueOnly: string; mode: string }>; url: string;
}) {
  const wide = Grid.useBreakpoint().md;
  const read = useDocumentRead<Result>(url), loading = read.phase === "loading";
  const rows = read.data?.rows ?? [], summary = read.data?.summary;
  const columns: ColumnsType<ProcessingCycleRow> = [
    { title: "工单 / 成品", key: "identity", width: wide ? 250 : 164, fixed: "left", render: (_, r) => <Space direction="vertical" size={2}>
      {link("wo", r.woNo)}<Typography.Text>{r.skuCode} · {r.skuName}</Typography.Text>
      <Typography.Text type="secondary">{r.supplierName}（#{r.supplierId}）</Typography.Text>
      <Tag>{r.orderType ? formatOrderType(r.orderType) : "未分类，不算返单"}</Tag>
    </Space> },
    { title: "订单 / 净入库", key: "qty", width: 155, render: (_, r) => `${formatQty(r.orderQty)} / ${formatQty(r.acceptedQty)} ${r.baseUom}` },
    { title: "审批→首批录单", dataIndex: "firstReceiptDays", width: 160, render: days },
    { title: "审批→全量净入库", dataIndex: "acceptedDays", width: 175, render: days,
      sorter: (a, b) => (a.acceptedDays ?? Infinity) - (b.acceptedDays ?? Infinity) },
    { title: "证据与判断", key: "evidence", width: 310, render: (_, r) => <Space direction="vertical" size={3}>
      <DocStatusTag status={r.status} />
      {r.issues.length ? r.issues.map(issue => <Typography.Text key={issue} type="secondary">{issue}</Typography.Text>) :
        <Typography.Text>{r.within20Days === null ? "加工段可评；不纳入返单目标" : r.within20Days ? "加工段≤20天（非客户交付达成）" : "加工段超过20天"}</Typography.Text>}
    </Space> },
  ];
  return <>
    <ListToolbar state={view} extra={<RemoteSelect api="/api/master/supplier" getLabel={r => `${String(r.code)} ${String(r.name)}`}
      allowClear placeholder="全部加工厂" style={{ width: 220, maxWidth: "100%" }} value={view.filters.supplierId ? Number(view.filters.supplierId) : undefined}
      onChange={v => view.setFilter({ supplierId: v == null ? "" : String(v) })} />}
      primaryActions={<>{read.data && <AsyncExportButton kind="wip" label="导出当前范围" params={{ mode: "cycles", ...(view.filters.supplierId ? { supplierId: Number(view.filters.supplierId) } : {}) }} />}<Button icon={<ReloadOutlined />} loading={loading} onClick={read.retry}>刷新</Button></>} />
    <LoadErrorAlert error={read.error} onRetry={read.retry} subject="加工周期" retrying={loading} />
    <Row gutter={[10, 10]} className="compact-kpi-row">
      <Col xs={12} lg={6}><Card size="small"><Statistic title="明确返单 / 工单" value={summary ? `${summary.repeats} / ${summary.orders}` : "—"} /></Card></Col>
      <Col xs={12} lg={6}><Card size="small"><Statistic title="加工段可评返单" value={summary?.validRepeats ?? "—"} /></Card></Col>
      <Col xs={12} lg={6}><Card size="small"><Statistic title="≤20天 / 可评返单" value={summary ? summary.validRepeats ? `${summary.within20} / ${summary.validRepeats}` : "无可评样本" : "—"} /></Card></Col>
      <Col xs={12} lg={6}><Card size="small"><Statistic title="返单待核实" value={summary?.unresolvedRepeats ?? "—"} /></Card></Col>
    </Row>
    <Space wrap style={{ margin: "12px 0" }}>
      <Typography.Text type="secondary">全部历史 · 一张WO一个样本 · 未分类 {summary?.unclassified ?? "—"} 张。展开查看凭据；不是客户交付达成率。</Typography.Text>
      <ContextHelp label="查看加工周期证据规则" title="加工周期证据规则" content={<>
        <p>审批取最新审批轮次的审批事实；首批及正常全收使用SH录单时间代理，净入库使用正常/返工成品的过账时间。都不是客户签收时间，也不包含需求到工单审批前的等待。</p>
        <p>一个WO拆多个JG仍只算一次。全量时点取实际净入库达到订单量的事件，不取最后一张收货单；冲销跌破订单量后重新判定。备品与物料消耗不计。</p>
        <p>仅明确repeat计入返单数，常规备货和未分类不自动认领。短关、身份冲突、倒序、未来日期或缺证据不评目标。≤20天包含快于10天；计数展示分母，不用少量样本推断稳定交期，不自动修改加工周期档案。</p>
      </>}>口径与证据</ContextHelp>
    </Space>
    <Table<ProcessingCycleRow> rowKey="woId" size={view.tableSize} loading={loading} columns={columns} dataSource={rows}
      scroll={{ x: 1040 }} pagination={{ pageSize: 20, showTotal: t => `共 ${t} 张工单` }}
      expandable={{ expandedRowRender: r => <Space direction="vertical" size={8} style={{ width: "100%", overflowWrap: "anywhere" }}>
        <span>审批：{time(r.approvedAt)}；首批录单：{time(r.firstReceiptAt)}</span>
        <span>正常全收录单：{time(r.normalFullAt)}；全量合格/让步净入库：{time(r.acceptedFullAt)}</span>
        <Space wrap>加工单：{r.jgNos.length ? r.jgNos.map(no => link("jg", no)) : "尚无"}</Space>
        <Space wrap>收货证据：{r.shNos.length ? r.shNos.map(no => link("sh", no)) : "尚无"}</Space>
        <Space wrap>达到全量凭据：{r.fullShNos.length ? r.fullShNos.map(no => link("sh", no)) : "尚无"}</Space>
      </Space> }} />
  </>;
}
