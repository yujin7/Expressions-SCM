"use client";

/**
 * E2-04 交期学习与供应商准时率（记分卡页第六页签）——历史 PO 承诺交期 vs 实际收货，
 * 算分布并提议档案交期（人工采纳）。
 *
 * 2026-09-04：从「计划与补货」分组的独立页 `/report/leadtime-learning` 并入本页。
 * 理由：同一个「交期」有三套算法口径——记分卡的 OTIF（准时率）、本页的系统学习值、
 * 「历史交期观察」的简道云观察值。三者并排才看得出彼此是否打架；分散在两个菜单分组里，
 * 计划员只会看见其中一个，然后拿它当唯一事实。旧路径保留为跳转（page.tsx → ?tab=leadtime）。
 *
 * URL 参数命名空间 lt_*（与 sc_/qc_/pv_/pt_/lh_ 互不干扰）。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Col, Popconfirm, Row, Space, Statistic, Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import SearchInput from "@/components/SearchInput";
import { useListState } from "@/components/useListState";

interface LtRow {
  supplierId: number;
  supplierName: string;
  skuId: number;
  code: string;
  name: string;
  samples: number;
  p50: number | null;
  p90: number | null;
  stdev: number | null;
  onTimeRate: number | null;
  avgDelayDays: number | null;
  currentLeadDays: number | null;
  suggestLeadDays: number | null;
  suggestReason: string;
}

interface LtData {
  rows: LtRow[];
  total: number;
  minSamples: number;
  deviationPct: number;
  summary: { pairCount: number; withSuggestion: number; avgOnTimeRate: number | null };
}

export default function LeadTimeLearningTab() {
  const { message } = App.useApp();
  const [data, setData] = useState<LtData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState<number | null>(null);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  const listState = useListState({ key: "leadtime-learning", paramPrefix: "lt", defaults: { q: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      setData(await fetchJson<LtData>(`/api/report/leadtime-learning?${params.toString()}`));
    } catch (e) {
      setData(null);
      setLoadError((e as Error).message);
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const apply = async (r: LtRow) => {
    if (r.suggestLeadDays == null) return;
    setApplying(r.skuId);
    try {
      await postJson("/api/report/leadtime-learning", { skuId: r.skuId, leadDays: r.suggestLeadDays });
      message.success(`已采纳：${r.code} 常规交期更新为 ${r.suggestLeadDays} 天`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setApplying(null);
    }
  };

  const columns: ColumnsType<LtRow> = [
    { title: "供应商", dataIndex: "supplierName", width: 160, ellipsis: true, fixed: "left" },
    {
      title: "SKU 编码", dataIndex: "code", width: 155,
      render: (v: string) => <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>,
    },
    { title: "名称", dataIndex: "name", width: 220, ellipsis: true },
    { title: "样本数", dataIndex: "samples", width: 80, align: "right" },
    { title: "P50 交期", dataIndex: "p50", width: 95, align: "right", render: (v: number | null) => (v == null ? "—" : `${v} 天`) },
    { title: "P90 交期", dataIndex: "p90", width: 95, align: "right", render: (v: number | null) => (v == null ? "—" : `${v} 天`) },
    {
      title: "波动 σ", dataIndex: "stdev", width: 90, align: "right",
      render: (v: number | null) => (v == null ? "—" : `±${v}`),
    },
    {
      title: "准时率", dataIndex: "onTimeRate", width: 90, align: "right",
      render: (v: number | null) =>
        v == null ? <Typography.Text type="secondary">无承诺</Typography.Text>
          : <Typography.Text style={{ color: v < 0.8 ? "#cf1322" : undefined }}>{(v * 100).toFixed(1)}%</Typography.Text>,
    },
    {
      title: "平均延误", dataIndex: "avgDelayDays", width: 100, align: "right",
      render: (v: number | null) =>
        v == null ? "—"
          : <Typography.Text style={{ color: v > 0 ? "#cf1322" : "#52c41a" }}>{v > 0 ? `+${v}` : v} 天</Typography.Text>,
    },
    { title: "档案交期", dataIndex: "currentLeadDays", width: 95, align: "right", render: (v: number | null) => (v == null ? <Typography.Text type="secondary">未设</Typography.Text> : `${v} 天`) },
    {
      title: "建议交期", dataIndex: "suggestLeadDays", width: 200, align: "right", fixed: "right",
      render: (v: number | null, r) =>
        v == null ? (
          <Tooltip title={r.suggestReason}><Typography.Text type="secondary">—</Typography.Text></Tooltip>
        ) : (
          <Space size={6}>
            <Tooltip title={r.suggestReason}><Typography.Text strong>{v} 天</Typography.Text></Tooltip>
            <Popconfirm
              title="采纳建议交期"
              description={`将 ${r.code} 的档案常规交期改为 ${v} 天（原 ${r.currentLeadDays ?? "未设"}）`}
              okText="采纳"
              cancelText="取消"
              onConfirm={() => void apply(r)}
            >
              <Button size="small" type="primary" ghost loading={applying === r.skuId}>采纳</Button>
            </Popconfirm>
          </Space>
        ),
    },
  ];

  const s = data?.summary;

  return (
    <div>
      {/* 每套交期口径在本页各挂自己的表头：三个页签同名不同算法，不写清楚就会被当成同一个数 */}
      <Typography.Title level={5} style={{ marginTop: 0 }}>交期学习与供应商准时率（系统学习值）</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="样本来自历史采购订单的承诺交期 vs 实际收货：按（供应商 × SKU）统计交期分布（P50/P90/波动 σ）、准时率与平均延误。"
        description={
          <Typography.Text type="secondary">
            建议值仅供人工采纳——点「采纳」才会写入 SKU 档案的常规交期，系统不会自动改主数据；
            样本少于 {data?.minSamples ?? 3} 单不作建议，偏差在 ±{data?.deviationPct ?? 20}% 容差内也不作建议。
            交期起算日 = 采购订单制单日，实际收货日 = 该订单该 SKU 首张生效收货单的录单日。
            与「历史交期观察」页签（简道云观察，只看不改）、「记分卡」页签的 OTIF 是三套独立口径，请并排对照后再采纳。
          </Typography.Text>
        }
      />

      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="交期学习" retrying={loading} />

      {/* 未加载 / 无样本 = 「—」而不是 0：0.0% 平均准时率会被读成「供应商全都不准时」 */}
      <Row gutter={[10, 10]} className="compact-kpi-row">
        <Col><Card size="small"><Statistic title="有样本的供应商-SKU 对" value={s ? s.pairCount : "—"} /></Card></Col>
        <Col><Card size="small"><Statistic title="有建议数" value={s ? s.withSuggestion : "—"} valueStyle={{ color: (s?.withSuggestion ?? 0) > 0 ? "#fa8c16" : undefined }} /></Card></Col>
        <Col>
          <Card size="small">
            <Statistic
              title={<Tooltip title="只统计有承诺交期的样本；一条承诺都没有时显示「—」，不是 0.0%"><span>平均准时率</span></Tooltip>}
              value={s?.avgOnTimeRate == null ? "—" : s.avgOnTimeRate * 100}
              precision={s?.avgOnTimeRate == null ? undefined : 1}
              suffix={s?.avgOnTimeRate == null ? "" : "%"}
              valueStyle={{ color: s?.avgOnTimeRate == null ? undefined : s.avgOnTimeRate < 0.8 ? "#cf1322" : "#52c41a" }}
            />
          </Card>
        </Col>
      </Row>

      <ListToolbar
        state={listState}
        extra={
          <SearchInput
            key={q}
            allowClear
            defaultValue={q}
            placeholder="搜索供应商/SKU 编码/名称"
            style={{ width: 260 }}
            onSearch={(v) => listState.setFilter({ q: v.trim() })}
          />
        }
      />

      <Table<LtRow>
        rowKey={(r) => `${r.supplierId}-${r.skuId}`}
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
        locale={{ emptyText: loadError ? "数据未加载" : "暂无可学习的交期样本" }}
      />
    </div>
  );
}
