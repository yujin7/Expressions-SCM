"use client";

import SearchInput from "@/components/SearchInput";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * 月度需求达成参考（demand 域 P1.5 前的登记层）：SKU×渠道 需求/期初/期末/销售达成。
 * 达成率=达成/需求 前端现算（源文件公式未缓存——不落假数）；月度重导整类替换。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Col, Progress, Row, Select, Space, Statistic, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import CaliberNote from "@/components/CaliberNote";
import DecisionVisual from "@/components/DecisionVisual";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";

interface Row {
  id: number;
  brandRaw: string | null;
  skuCode: string | null;
  skuId: number | null;
  materialName: string | null;
  orderType: string | null; // 产品类型
  qty: string | null; // 需求
  doneQty: string | null; // 销售达成
  usedQty: string | null; // 期初（槽位映射）
  remainQty: string | null; // 期末
  follower: string | null; // 渠道
  progress: string | null; // YYYY-MM
}

interface DemandSummary {
  kind: "demand";
  rowCount: number;
  mappedRows: number;
  demandQty: number;
  doneQty: number;
  achievementRate: number | null;
  byChannel: {
    name: string;
    demandQty: number;
    doneQty: number;
    achievementRate: number | null;
  }[];
}

function DemandTab() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [importedAt, setImportedAt] = useState<string | null>(null);
  const [summary, setSummary] = useState<DemandSummary | null>(null);
  const [loading, setLoading] = useState(false);
  // 本页签独立列表状态：URL 参数命名空间 dm_*（与「货盘处置」「总库存核对」互不干扰）
  const listState = useListState({
    key: "demand-demand",
    paramPrefix: "dm",
    defaults: { q: "", channel: "" },
    defaultPageSize: 20,
  });
  const { page, pageSize } = listState;
  const q = listState.filters.q;
  const channel = listState.filters.channel;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        kind: "demand",
        q,
        channel,
        page: String(page),
        pageSize: String(pageSize),
        includeSummary: "1",
      });
      const res = await fetchJson<{ rows: Row[]; total: number; importedAt: string | null; summary: DemandSummary | null }>(
        `/api/report/transit?${params.toString()}`,
      );
      setRows(res.rows);
      setTotal(res.total);
      setImportedAt(res.importedAt);
      setSummary(res.summary);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, channel, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const rate = (r: Row): string | null => {
    const d = Number(r.qty ?? 0);
    const a = Number(r.doneQty ?? 0);
    if (d <= 0) return null;
    return `${Math.round((a / d) * 1000) / 10}%`;
  };

  const columns: ColumnsType<Row> = [
    { title: "品牌", dataIndex: "brandRaw", width: 110 },
    {
      title: "编码",
      dataIndex: "skuCode",
      width: 130,
      render: (v: string | null, r) =>
        v ? (
          <Space size={4}>
            <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>
            {r.skuId == null ? <Tag>未建档</Tag> : null}
          </Space>
        ) : (
          "—"
        ),
    },
    { title: "名称", dataIndex: "materialName", ellipsis: true, width: 210 },
    { title: "类型", dataIndex: "orderType", width: 80, render: (v: string | null) => v ?? "—" },
    { title: "渠道", dataIndex: "follower", width: 110, render: (v: string | null) => <Tag>{v}</Tag> },
    { title: "需求", dataIndex: "qty", width: 90, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    { title: "销售达成", dataIndex: "doneQty", width: 100, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    {
      title: "达成率",
      width: 90,
      align: "right",
      render: (_, r) => {
        const s = rate(r);
        if (s == null) return "—";
        const n = parseFloat(s);
        return <Tag color={n >= 100 ? "green" : n >= 60 ? "orange" : "red"}>{s}</Tag>;
      },
    },
    { title: "期初", dataIndex: "usedQty", width: 90, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    { title: "期末", dataIndex: "remainQty", width: 90, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
  ];

  return (
    <div>
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="口径：月度「需求&计划&达成统计表」重导登记（整类替换）；达成率=销售达成÷需求 现算。源文件的总需求/动销率等公式列未缓存值——本页只呈现字面数据，不造数（D30 销售金额域 P1）。"
      />
      <DecisionVisual
        title="需求达成总览"
        question="本月登记需求完成了多少，缺口集中在哪些渠道？"
        metricId="demandAchievement"
        grain="SKU × 渠道（月）"
        unit="数量 / 达成率"
        source={{
          tier: "reference",
          source: "业务部需求、计划与达成月度登记",
          asOf: importedAt ? new Date(importedAt).toLocaleDateString("zh-CN") : null,
        }}
        coverage={summary ? {
          covered: summary.mappedRows,
          total: summary.rowCount,
          label: "已映射 SKU 行",
        } : undefined}
        activeFilters={[channel ? `渠道：${channel}` : "全部渠道", q ? `搜索：${q}` : "全部 SKU"]}
        summary={
          summary
            ? `登记需求 ${formatQty(String(summary.demandQty))}，销售达成 ${formatQty(String(summary.doneQty))}，达成率 ${summary.achievementRate == null ? "数据不足" : `${summary.achievementRate}%`}。`
            : "需求达成数据尚未加载。"
        }
        caveat="登记文件是月度参考层，不等同于实时订单承诺；缺收入、毛利、促销与库存断货事实。"
        state={loading && !summary ? "loading" : !summary || summary.rowCount === 0 ? "empty" : summary.achievementRate == null ? "insufficient" : "ready"}
        stateDetail="请先导入月度需求与达成文件，或调整当前筛选。"
        height={Math.max(220, (summary?.byChannel.length ?? 0) * 42 + 72)}
        fitContent
        dataView={
          <Table
            rowKey="name"
            size="small"
            pagination={false}
            dataSource={summary?.byChannel ?? []}
            columns={[
              { title: "渠道", dataIndex: "name" },
              { title: "需求", dataIndex: "demandQty", align: "right", render: (value: number) => formatQty(String(value)) },
              { title: "达成", dataIndex: "doneQty", align: "right", render: (value: number) => formatQty(String(value)) },
              { title: "达成率", dataIndex: "achievementRate", align: "right", render: (value: number | null) => value == null ? "数据不足" : `${value}%` },
            ]}
          />
        }
      >
        <Row gutter={[12, 12]}>
          <Col xs={12} md={8}>
            <Statistic title="登记需求" value={summary?.demandQty ?? 0} />
          </Col>
          <Col xs={12} md={8}>
            <Statistic title="销售达成" value={summary?.doneQty ?? 0} />
          </Col>
          <Col xs={24} md={8}>
            <Statistic title="加权达成率" value={summary?.achievementRate ?? 0} suffix="%" />
          </Col>
        </Row>
        <Space direction="vertical" size={8} style={{ width: "100%", marginTop: 12 }}>
          {(summary?.byChannel ?? []).map((item) => (
            <div key={item.name} style={{ display: "grid", gridTemplateColumns: "110px 1fr 64px", gap: 8, alignItems: "center" }}>
              <Typography.Text ellipsis>{item.name}</Typography.Text>
              <Progress
                percent={Math.min(item.achievementRate ?? 0, 100)}
                showInfo={false}
                status={(item.achievementRate ?? 0) >= 100 ? "success" : (item.achievementRate ?? 0) < 60 ? "exception" : "normal"}
              />
              <Typography.Text style={{ textAlign: "right" }}>
                {item.achievementRate == null ? "—" : `${item.achievementRate}%`}
              </Typography.Text>
            </div>
          ))}
        </Space>
      </DecisionVisual>
      <ListToolbar
        state={listState}
        extra={
          <>
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索编码/名称"
              style={{ width: 260 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
            <Select
              allowClear
              placeholder="全部渠道"
              style={{ width: 160 }}
              value={channel || undefined}
              onChange={(value) => listState.setFilter({ channel: value ?? "" })}
              options={["天猫", "拼多多", "唯品会", "京东", "抖音商品卡", "私域", "商务", "品牌中心", "海外运营部"].map((v) => ({ value: v, label: v }))}
            />
            {importedAt ? <Tag color="green">导入于 {new Date(importedAt).toLocaleDateString("zh-CN")}</Tag> : <Tag>尚未导入</Tag>}
          </>
        }
      />
      <Table<Row>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: total, showTotal: (n) => `共 ${n} 条（SKU×渠道）` })}
      />
    </div>
  );
}


interface PalletRow {
  id: number;
  brandRaw: string | null;
  skuCode: string | null;
  skuId: number | null;
  materialName: string | null;
  qty: string | null; // 当前库存（月末）
  doneQty: string | null; // 月销量
  exception: string | null; // 处置注记
  progress: string | null;
  extra: { 近三月日均销?: number | null; 可销天数_文件口径?: number | null; 是否滞销_文件口径?: string | null } | null;
}

/** 货盘处置参考：PMC 月度货盘 + 处置注记（R14 备注字典源）；文件口径指标并列供与系统口径对照 */
function PalletTab({ initialQ = "" }: { initialQ?: string }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<PalletRow[]>([]);
  const [total, setTotal] = useState(0);
  const [importedAt, setImportedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 本页签独立列表状态：URL 参数命名空间 pl_*；
  // 深链 /report/demand?tab=pallet&q=CODE 的裸 q 作为本实例的默认值，链接仍能直接过滤
  const listState = useListState({
    key: "demand-pallet",
    paramPrefix: "pl",
    defaults: { q: initialQ, onlyRemark: "0" },
    defaultPageSize: 20,
  });
  const { page, pageSize } = listState;
  const q = listState.filters.q;
  const onlyRemark = listState.filters.onlyRemark === "1";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        kind: "pallet",
        q,
        onlyRemark: onlyRemark ? "1" : "0",
        page: String(page),
        pageSize: String(pageSize),
      });
      const res = await fetchJson<{ rows: PalletRow[]; total: number; importedAt: string | null }>(
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
  }, [q, onlyRemark, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const remarkColor = (v: string): string =>
    v.includes("报废") || v.includes("过期") ? "red" : v.includes("临期") ? "volcano" : v.includes("停") ? "orange" : "blue";

  const cols: ColumnsType<PalletRow> = [
    { title: "品牌", dataIndex: "brandRaw", width: 110 },
    {
      title: "编码",
      dataIndex: "skuCode",
      width: 130,
      render: (v: string | null, r) =>
        v ? (
          <Space size={4}>
            <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>
            {r.skuId == null ? <Tag>未建档</Tag> : null}
          </Space>
        ) : (
          "—"
        ),
    },
    { title: "名称", dataIndex: "materialName", ellipsis: true, width: 220 },
    { title: "月末库存", dataIndex: "qty", width: 100, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    { title: "月销量", dataIndex: "doneQty", width: 90, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    {
      title: "可销天数（文件口径）",
      width: 150,
      align: "right",
      render: (_, r) => {
        const d = r.extra?.可销天数_文件口径;
        if (d == null) return "—";
        const n = Math.round(d);
        return (
          <Tooltip title="货盘文件当月口径；系统实时口径见驾驶舱/补货建议">
            <Tag color={n < 30 ? "red" : n > 180 ? "orange" : "green"}>{n.toLocaleString("zh-CN")}天</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: "滞销（文件）",
      width: 100,
      render: (_, r) => {
        const v = r.extra?.是否滞销_文件口径;
        return v ? <Tag color={v === "是" ? "orange" : "default"}>{v}</Tag> : "—";
      },
    },
    {
      title: "处置注记",
      dataIndex: "exception",
      width: 220,
      render: (v: string | null) => (v ? <Tag color={remarkColor(v)}>{v}</Tag> : "—"),
    },
  ];

  return (
    <div>
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="口径：PMC 月度货盘登记（整类替换）。处置注记（过期待报废/临期禁售/商务库存…）为业务处置依据；可销天数/滞销为文件当月口径，与系统实时口径（驾驶舱/补货建议）并存对照。成本单价列按 D2 裁决不入库。"
      />
      <ListToolbar
        state={listState}
        extra={
          <>
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索编码/名称"
              style={{ width: 260 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
            <Tag.CheckableTag checked={onlyRemark} onChange={(checked) => listState.setFilter({ onlyRemark: checked ? "1" : "0" })} style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}>
              只看有处置注记
            </Tag.CheckableTag>
            {importedAt ? <Tag color="green">导入于 {new Date(importedAt).toLocaleDateString("zh-CN")}</Tag> : <Tag>尚未导入</Tag>}
          </>
        }
      />
      <Table<PalletRow>
        rowKey="id"
        size={listState.tableSize}
        columns={cols}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: total })}
      />
    </div>
  );
}

interface SummaryRow {
  id: number;
  skuCode: string | null;
  skuId: number | null;
  materialName: string | null;
  orderType: string | null;
  qty: string | null; // 文件商品数量（全公司口径）
  inboundQty: string | null; // 已下单未出货
  progress: string | null;
  extra: { 总日均销量?: number | null; 总计划可销天数?: number | null } | null;
  /** E1-02：查询时实时计算（不再读烘焙值） */
  sysQty?: number | null;
  diffQty?: number | null;
}

interface StockCoverageSummary {
  kind: "stock_summary";
  rowCount: number;
  comparableRows: number;
  agreeRows: number;
  diffRows: number;
  unmappedRows: number;
}

/** 总库存核对：文件=全公司口径 vs 系统=自有+电商部快照——差异主因=海外/其他部门仓不在快照源（覆盖缺口已量化） */
function StockSummaryTab() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [coverage, setCoverage] = useState<StockCoverageSummary | null>(null);
  const [importedAt, setImportedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 本页签独立列表状态：URL 参数命名空间 ss_*
  const listState = useListState({
    key: "demand-stock-summary",
    paramPrefix: "ss",
    defaults: { q: "" },
    defaultPageSize: 20,
  });
  const { page, pageSize } = listState;
  const q = listState.filters.q;
  const [onlyDiff, setOnlyDiff] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        kind: "stock_summary",
        q,
        page: String(page),
        pageSize: String(pageSize),
        includeSummary: "1",
      });
      const res = await fetchJson<{
        rows: SummaryRow[];
        total: number;
        importedAt: string | null;
        summary: StockCoverageSummary | null;
      }>(`/api/report/transit?${params.toString()}`);
      setRows(onlyDiff ? res.rows.filter((r) => Math.abs(r.diffQty ?? 0) >= 0.5) : res.rows);
      setTotal(res.total);
      setCoverage(res.summary);
      setImportedAt(res.importedAt);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, onlyDiff, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const cols: ColumnsType<SummaryRow> = [
    { title: "编码", dataIndex: "skuCode", width: 130, render: (v: string | null, r) => v ? <Space size={4}><a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>{r.skuId == null ? <Tag>未建档</Tag> : null}</Space> : "—" },
    { title: "名称", dataIndex: "materialName", ellipsis: true, width: 210 },
    { title: "类型", dataIndex: "orderType", width: 90, render: (v: string | null) => v ?? "—" },
    { title: "文件总库存", dataIndex: "qty", width: 110, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    { title: "系统数（核对时）", width: 130, align: "right", render: (_, r) => (r.sysQty != null ? formatQty(String(r.sysQty)) : "—") },
    {
      title: "差异（系统−文件）", width: 140, align: "right",
      render: (_, r) => {
        const d = r.diffQty;
        if (d == null) return "—";
        if (Math.abs(d) < 0.5) return <Tag color="green">一致</Tag>;
        return <Tooltip title="差异主因：海外/其他部门仓不在电商部快照源内（覆盖口径），非记账错误"><Tag color={d < 0 ? "orange" : "blue"}>{d > 0 ? "+" : ""}{formatQty(String(d))}</Tag></Tooltip>;
      },
    },
    { title: "在订未出", dataIndex: "inboundQty", width: 100, align: "right", render: (v: string | null) => (v == null ? "—" : formatQty(v)) },
    { title: "总日均销（文件）", width: 120, align: "right", render: (_, r) => r.extra?.总日均销量 != null ? String(Math.round((r.extra.总日均销量 as number) * 100) / 100) : "—" },
  ];

  return (
    <div>
      <CaliberNote
        summary="文件总库存与系统库存是不同覆盖范围；差异先判断覆盖缺口，不自动判定为记账错误。"
        detail="文件「商品数量」含海外与其他部门仓；系统数为自有实时账加电商部最新快照。全量核对按 SKU 编码映射，未映射行与可比行分开呈现。"
      />
      <DecisionVisual
          title="库存事实覆盖与一致性"
          question="有多少 SKU 真正可比，可比部分有多少一致，差异是否可能来自仓库覆盖？"
          metricId="coverageSku"
          grain="SKU"
          unit="SKU 数 / 覆盖率"
          source={{
            tier: "reference",
            source: "总库存明细 × 当前库存过账台账 × 最新仓库快照",
            asOf: importedAt ? new Date(importedAt).toLocaleDateString("zh-CN") : null,
          }}
          coverage={coverage ? {
            covered: coverage.comparableRows,
            total: coverage.rowCount,
            label: "编码可比",
          } : undefined}
          activeFilters={[q ? `搜索：${q}` : "全部 SKU"]}
          summary={
            coverage
              ? `共 ${coverage.rowCount} 行，${coverage.comparableRows} 行可比；其中 ${coverage.agreeRows} 行一致，${coverage.diffRows} 行有差异，${coverage.unmappedRows} 行未映射。`
              : "库存覆盖数据尚未加载。"
          }
          caveat="一致阈值为绝对差异小于 0.5；差异可能来自海外/其他部门仓未接入，不能直接推断为账本错误。"
          state={loading && !coverage ? "loading" : !coverage || coverage.rowCount === 0 ? "empty" : "ready"}
          stateDetail="请先导入总库存明细，或调整当前筛选。"
          height={220}
          fitContent
          dataView={
            <Table<{ key: string; label: string; count: number; denominator: number }>
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={coverage ? [
                { key: "comparable", label: "编码可比", count: coverage.comparableRows, denominator: coverage.rowCount },
                { key: "agreement", label: "可比且一致", count: coverage.agreeRows, denominator: coverage.comparableRows },
                { key: "difference", label: "可比但有差异", count: coverage.diffRows, denominator: coverage.comparableRows },
                { key: "unmapped", label: "编码未映射", count: coverage.unmappedRows, denominator: coverage.rowCount },
              ] : []}
              columns={[
                { title: "检查项", dataIndex: "label" },
                { title: "SKU 数", dataIndex: "count", align: "right" },
                {
                  title: "比例",
                  align: "right",
                  render: (_value, row: { count: number; denominator: number }) =>
                    row.denominator > 0 ? `${Math.round((row.count / row.denominator) * 100)}%` : "—",
                },
              ]}
            />
          }
        >
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <Typography.Text>编码覆盖</Typography.Text>
              <Progress
                percent={coverage && coverage.rowCount > 0 ? Math.round((coverage.comparableRows / coverage.rowCount) * 100) : 0}
                format={() => coverage ? `${coverage.comparableRows}/${coverage.rowCount}` : "—"}
                status={coverage && coverage.unmappedRows > 0 ? "exception" : "success"}
              />
            </Col>
            <Col xs={24} md={12}>
              <Typography.Text>可比行一致率</Typography.Text>
              <Progress
                percent={coverage && coverage.comparableRows > 0 ? Math.round((coverage.agreeRows / coverage.comparableRows) * 100) : 0}
                format={() => coverage ? `${coverage.agreeRows}/${coverage.comparableRows}` : "—"}
                status={coverage && coverage.diffRows > 0 ? "exception" : "success"}
              />
            </Col>
          </Row>
          <Alert
            style={{ marginTop: 12 }}
            type={coverage && coverage.diffRows > 0 ? "warning" : "success"}
            showIcon
            message={coverage ? `${coverage.diffRows} 个可比 SKU 需要按仓库覆盖继续核对` : "等待核对结果"}
          />
      </DecisionVisual>
      <ListToolbar
        state={listState}
        extra={
          <>
            <SearchInput key={q} allowClear defaultValue={q} placeholder="搜索编码/名称" style={{ width: 260 }} onSearch={(v) => listState.setFilter({ q: v.trim() })} />
            <Tag.CheckableTag checked={onlyDiff} onChange={setOnlyDiff} style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}>本页只看差异</Tag.CheckableTag>
          </>
        }
      />
      <Table<SummaryRow> rowKey="id" size={listState.tableSize} columns={cols} dataSource={rows} loading={loading} scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: total })} />
    </div>
  );
}

export default function DemandClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = ["demand", "pallet", "stock_summary"].includes(searchParams.get("tab") ?? "") ? (searchParams.get("tab") as string) : "demand";
  const initialQ = searchParams.get("q") ?? "";
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        需求达成与货盘参考
      </Typography.Title>
      <Tabs
        activeKey={initialTab}
        onChange={(tab) => {
          const next = new URLSearchParams(searchParams.toString());
          if (tab === "demand") next.delete("tab");
          else next.set("tab", tab);
          router.replace(`/report/demand${next.size > 0 ? `?${next.toString()}` : ""}`, { scroll: false });
        }}
        items={[
          { key: "demand", label: "需求达成", children: <DemandTab /> },
          { key: "pallet", label: "货盘处置", children: <PalletTab initialQ={initialQ} /> },
          { key: "stock_summary", label: "总库存核对", children: <StockSummaryTab /> },
        ]}
      />
    </div>
  );
}
