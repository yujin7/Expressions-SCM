"use client";

/**
 * 主数据健康度（只读，不写库）。
 * 两个页签回答一体两面的问题：
 *  - 缺失清单：主数据**缺什么**（逐 SKU 完整度评分）
 *  - 疑似重复：主数据**多了什么**（同一实物被建了多条主档）
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert, App, Input, Progress, Space, Statistic, Switch, Table, Tag, Tooltip, Typography } from "antd";
import { Tabs } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import CaliberNote from "@/components/CaliberNote";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import SkuHoverCard from "@/components/SkuHoverCard";

interface DataHealthRow {
  skuId: number;
  code: string;
  name: string;
  skuType: string;
  brand: string | null;
  missing: string[];
  score: number;
}

interface DataHealthSummary {
  totalSkus: number;
  fullyHealthy: number;
  byDimension: Record<string, number>;
}

/** 结构性告警：不归属单个 SKU 的主数据问题（服务端无命中时为空数组，页面不占位） */
interface StructuralWarning {
  key: string;
  severity: "high" | "medium";
  title: string;
  impact: string;
  count: number;
  samples: string[];
}

interface DataHealthData {
  rows: DataHealthRow[];
  total: number;
  summary: DataHealthSummary;
  structural?: StructuralWarning[];
}

const DIMENSIONS = ["生产周期", "起订量", "BOM", "条码", "品牌"];

const TYPE_LABELS: Record<string, string> = {
  finished: "成品",
  semi: "半成品",
  raw: "原料",
  packaging: "包材",
  service: "服务",
};

function scoreColor(v: number): string {
  return v < 50 ? "#cf1322" : v < 80 ? "#d46b08" : "#389e0d";
}

/* ─────────────────────────── 页签一：缺失清单 ─────────────────────────── */

function MissingTab() {
  const { message } = App.useApp();
  const [data, setData] = useState<DataHealthData | null>(null);
  const [loading, setLoading] = useState(false);
  // 本页签独立列表状态：URL 参数命名空间 ms_*（与「疑似重复」互不干扰）
  const listState = useListState({
    key: "data-health",
    paramPrefix: "ms",
    defaults: { q: "", missing: "" },
    defaultPageSize: 50,
  });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const missing = filters.missing;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (missing) params.set("missing", missing);
      setData(await fetchJson<DataHealthData>(`/api/report/data-health?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, missing, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const summary = data?.summary;
  const healthRate = summary && summary.totalSkus > 0 ? Math.round((100 * summary.fullyHealthy) / summary.totalSkus) : 0;

  const columns: ColumnsType<DataHealthRow> = [
    {
      title: "完整度",
      dataIndex: "score",
      width: 150,
      fixed: "left",
      render: (v: number) => (
        <Progress percent={v} size="small" strokeColor={scoreColor(v)} format={(p) => `${p}分`} style={{ width: 130, marginBottom: 0 }} />
      ),
    },
    { title: "SKU 编码", dataIndex: "code", width: 150, render: (v: string) => <SkuHoverCard code={v} /> },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    { title: "类型", dataIndex: "skuType", width: 90, render: (v: string) => TYPE_LABELS[v] ?? v },
    { title: "品牌", dataIndex: "brand", width: 110, render: (v: string | null) => v ?? "—" },
    {
      title: "缺失项",
      dataIndex: "missing",
      render: (v: string[]) => (
        <Space size={4} wrap>
          {v.map((m) => (
            <Tag color="red" key={m} style={{ marginInlineEnd: 0 }}>{m}</Tag>
          ))}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <CaliberNote
        summary={<>完整度＝各适用维度完整占比；只列出有缺失项的 SKU（完全健康的计入统计不进列表）。</>}
        detail={<div><p>按货品类型裁剪适用维度：成品评 生产周期 / 起订量 / BOM / 条码 / 品牌 五项；原料/包材仅评 条码 / 品牌。条码为 null 或 malformed 记缺失。</p></div>}
      />
      {/* 结构性告警：命中才渲染——无命中时整块不出现，不留空占位 */}
      {(data?.structural ?? []).map((w) => (
        <Alert
          key={w.key}
          type={w.severity === "high" ? "error" : "warning"}
          showIcon
          style={{ marginBottom: 12 }}
          message={w.title}
          description={
            <>
              <div style={{ marginBottom: 6 }}>{w.impact}</div>
              <div style={{ color: "#666", fontSize: 12 }}>
                涉及：{w.samples.join("、")}
                {w.count > w.samples.length ? ` 等 ${w.count} 项` : ""}
              </div>
            </>
          }
        />
      ))}
      <Space size="large" style={{ marginBottom: 12 }} wrap>
        <Statistic title="总 SKU" value={summary?.totalSkus ?? 0} />
        <Statistic title="完全健康" value={summary?.fullyHealthy ?? 0} suffix={summary ? `/ ${healthRate}%` : undefined} />
        <Statistic title="待修复" value={data?.total ?? 0} valueStyle={{ color: "#cf1322" }} />
      </Space>
      <ListToolbar
        state={listState}
        extra={
          <>
            {DIMENSIONS.map((d) => (
              <Tag.CheckableTag
                key={d}
                checked={missing === d}
                onChange={(c) => listState.setFilter({ missing: c ? d : "" })}
                style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}
              >
                {d} 缺失（{summary?.byDimension[d] ?? 0}）
              </Tag.CheckableTag>
            ))}
            <Input.Search
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索编码/名称"
              style={{ width: 240 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
          </>
        }
      />
      <Table<DataHealthRow>
        rowKey="skuId"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0, showTotal: (t) => `共 ${t} 条待修复` })}
      />
    </div>
  );
}

/* ─────────────────────────── 页签二：疑似重复 ─────────────────────────── */

interface DupeMember {
  skuId: number;
  code: string;
  name: string;
  skuType: string;
  brand: string | null;
  onHand: number;
  hasBom: boolean;
}

interface DupeClusterRow {
  members: DupeMember[];
  topScore: number;
  reasons: string[];
  crossBrand: boolean;
  suggestedKeepSkuId: number;
  keepReason: string;
  stockAtRisk: number;
}

interface DupeData {
  rows: DupeClusterRow[];
  total: number;
  scanned: number;
  affectedSkus: number;
  clustersWithStock: number;
  exactCount: number;
  threshold: number;
  note: string;
}

function DuplicatesTab() {
  const { message } = App.useApp();
  const [data, setData] = useState<DupeData | null>(null);
  const [loading, setLoading] = useState(false);
  // 本页签独立列表状态：URL 参数命名空间 dp_*
  const listState = useListState({
    key: "data-health-dupe",
    paramPrefix: "dp",
    defaults: { q: "", exactOnly: "", sameBrandOnly: "" },
    defaultPageSize: 20,
  });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const exactOnly = filters.exactOnly === "1";
  const sameBrandOnly = filters.sameBrandOnly === "1";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (exactOnly) params.set("exactOnly", "1");
      if (sameBrandOnly) params.set("crossBrand", "0");
      setData(await fetchJson<DupeData>(`/api/report/data-health/duplicates?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, exactOnly, sameBrandOnly, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const columns: ColumnsType<DupeClusterRow> = [
    {
      title: "可疑度",
      dataIndex: "topScore",
      width: 110,
      fixed: "left",
      render: (v: number, r) => (
        <Space direction="vertical" size={2}>
          <Tag color={v === 1 ? "red" : "orange"} style={{ marginInlineEnd: 0 }}>
            {v === 1 ? "完全同名" : `${Math.round(v * 100)}%`}
          </Tag>
          {r.crossBrand ? <Tag style={{ marginInlineEnd: 0 }}>跨品牌</Tag> : null}
        </Space>
      ),
    },
    {
      title: "同组主档（★ = 建议保留）",
      key: "members",
      render: (_, r) => (
        <Space direction="vertical" size={2} style={{ width: "100%" }}>
          {r.members.map((m) => {
            const keep = m.skuId === r.suggestedKeepSkuId;
            return (
              <div key={m.skuId} style={{ fontWeight: keep ? 600 : 400 }}>
                {keep ? "★ " : "　 "}
                <SkuHoverCard code={m.code} />
                <span style={{ marginLeft: 8 }}>{m.name}</span>
                <span style={{ marginLeft: 8, color: "#888", fontSize: 12 }}>
                  在库 {m.onHand}
                  {m.hasBom ? " · 有生效 BOM" : ""}
                  {m.brand ? ` · ${m.brand}` : ""}
                </span>
              </div>
            );
          })}
        </Space>
      ),
    },
    {
      title: "合并影响",
      dataIndex: "stockAtRisk",
      width: 190,
      render: (v: number) =>
        v > 0 ? (
          <Tooltip title="待并项身上还压着库存。合并不是改主档的文书工作——必须先把货调走或清零，否则库存会连同错误主档一起消失。">
            <Tag color="volcano">待并项有库存 {v}</Tag>
          </Tooltip>
        ) : (
          <span style={{ color: "#888" }}>无库存，仅主档整理</span>
        ) as React.ReactNode,
    },
    {
      title: "建议依据",
      dataIndex: "keepReason",
      width: 200,
      render: (v: string) => <span style={{ color: "#666", fontSize: 12 }}>{v}</span>,
    },
  ];

  return (
    <div>
      <CaliberNote
        summary={<>按名称归一化后比对，识别<strong>同一实物被建了多条主档</strong>。<strong>只产出候选，系统不会自动合并。</strong></>}
        detail={
          <div>
            <p>归一化只统一书写形式（全半角、大小写、括号、空白、分隔符），<strong>保留规格的值</strong>——「泥膜(110g)」与「泥膜(20g)」是两个 SKU，不会被判成重复。</p>
            <p>两个硬判别器一票否决：<strong>规格</strong>不同（10ml/15ml/30ml）、<strong>剂型</strong>不同（水/液/乳/霜/膜/油）即判为不同产品，不参与相似度打分。簇内要求两两都达阈值，避免整条产品线被串成一组。</p>
            <p>合并会牵动库存、台账与 BOM，必须人工裁决。「建议保留」按证据排序：有生效 BOM &gt; 在库最多 &gt; 建档最早。</p>
          </div>
        }
      />
      {data ? (
        <Alert
          type={data.clustersWithStock > 0 ? "warning" : "info"}
          showIcon
          style={{ marginBottom: 12 }}
          message={data.note}
        />
      ) : null}
      <Space size="large" style={{ marginBottom: 12 }} wrap>
        <Statistic title="疑似重复组" value={data?.total ?? 0} valueStyle={{ color: "#d46b08" }} />
        <Statistic title="完全同名（建议先处理）" value={data?.exactCount ?? 0} valueStyle={{ color: "#cf1322" }} />
        <Statistic title="涉及 SKU" value={data?.affectedSkus ?? 0} suffix={data ? `/ ${data.scanned}` : undefined} />
        <Statistic title="待并项有库存" value={data?.clustersWithStock ?? 0} />
      </Space>
      <ListToolbar
        state={listState}
        extra={
          <>
            <Space size={4}>
              <Switch
                size="small"
                checked={exactOnly}
                onChange={(c) => listState.setFilter({ exactOnly: c ? "1" : "" })}
              />
              <span>只看完全同名</span>
            </Space>
            <Space size={4}>
              <Switch
                size="small"
                checked={sameBrandOnly}
                onChange={(c) => listState.setFilter({ sameBrandOnly: c ? "1" : "" })}
              />
              <span>只看同品牌</span>
            </Space>
            <Input.Search
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索编码/名称"
              style={{ width: 240 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
          </>
        }
      />
      <Table<DupeClusterRow>
        rowKey={(r) => r.members.map((m) => m.skuId).join("-")}
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0, showTotal: (t) => `共 ${t} 组候选` })}
      />
    </div>
  );
}

export default function DataHealthClient() {
  // ?tab=duplicates 深链（与 /report/demand?tab= 同约定）：告警与复核项可直接指到「疑似重复」
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") === "duplicates" ? "duplicates" : "missing";
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>主数据健康度</Typography.Title>
      <Tabs
        defaultActiveKey={initialTab}
        items={[
          { key: "missing", label: "缺失清单", children: <MissingTab /> },
          { key: "duplicates", label: "疑似重复", children: <DuplicatesTab /> },
        ]}
      />
    </div>
  );
}
