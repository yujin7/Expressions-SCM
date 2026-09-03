"use client";

/**
 * 补货试点候选（D59 R5）：候选 = 生效分层 S/A/B ∧ XYZ=X ∧ 加工/在途周期已维护 ∧ 无异动命中。
 * 同页提供「固化本期分层」（pmc）与「纳入/移出试点」（pmc）。读模型 replenish-pilot/v1。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Alert, App, Button, Col, Row, Select, Space, Statistic, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { CheckCircleOutlined, ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import CaliberNote from "@/components/CaliberNote";
import { fetchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import SearchInput from "@/components/SearchInput";
import SkuHoverCard from "@/components/SkuHoverCard";
import { useListState } from "@/components/useListState";

type Tier = "S" | "A" | "B" | "C";

interface PilotRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  tier: Tier;
  tierSource: "policy" | "policy_override" | "live";
  xyz: "X" | "Y" | "Z" | null;
  cv: number;
  ownership: string;
  ownershipLabel: string;
  sales6m: number;
  leadDaysKnown: boolean;
  detectorHit: boolean;
  pilot: boolean;
  eligible: boolean;
  blockers: string[];
}

interface PilotModel {
  builtAt: string;
  period: string | null;
  months: string[];
  scanned: number;
  totalSales6m: number;
  candidates: number;
  candidateSales6m: number;
  candidateSalesSharePct: number;
  pilotMarked: number;
  pilotSalesSharePct: number;
  byTier: Record<Tier, { total: number; eligible: number }>;
  blockers: { tierC: number; xyzNotX: number; xyzUnclassified: number; leadMissing: number; detectorHit: number };
  rows: PilotRow[];
  notes: string[];
}

/** 固化接口返回的阻塞分布（planning/policy.PolicyBlockers） */
interface BuildBlockers { leadDaysUnknown: number; xyzNull: number; xyzNotX: number; detectorHit: number; candidates: number }

const TIER_COLORS: Record<Tier, string> = { S: "magenta", A: "red", B: "orange", C: "default" };
const XYZ_COLORS: Record<string, string> = { X: "green", Y: "gold", Z: "volcano" };

/**
 * 「为什么直出为 0」：S/A/B 中各阻塞维度的 SKU 数（一个 SKU 可同时计入多项）。
 * 周期缺失可当场补录（/master/supply-params 只看阻塞）；波动/异动是数据事实，只能等窗口或人工联审。
 */
function WhyDirectZero({ model }: { model: PilotModel }) {
  const sab = model.byTier.S.total + model.byTier.A.total + model.byTier.B.total;
  const b = model.blockers;
  const items: { label: string; count: number; hint: string }[] = [
    { label: "加工/在途周期未维护", count: b.leadMissing, hint: "sku_params 加工周期 >0 且在途周期已填才算已知；可在周期主数据补录页当场解除" },
    { label: "波动样本不足/无动销", count: b.xyzUnclassified, hint: "近 6 月不足 6 个有效点或无动销，规则层 XYZ=null（不假装 Z）" },
    { label: "需求波动 Y/Z", count: b.xyzNotX, hint: "CV>0.5，规则层不判为稳定品" },
    { label: "异动侦测命中", count: b.detectorHit, hint: "销量骤停/渠道迁移/速度突变任一命中（report/detectors）" },
  ];
  const zero = model.candidates === 0;
  return (
    <Alert
      type={zero ? "warning" : "info"}
      showIcon
      style={{ marginBottom: 12 }}
      message={zero ? `为什么「供应链直出」为 0：S/A/B 共 ${sab} 个 SKU，逐维度阻塞如下` : `直出候选 ${model.candidates} / S/A/B ${sab}：其余按阻塞维度分布如下`}
      description={
        <Space wrap size={[16, 4]}>
          {items.map((it) => (
            <Tooltip key={it.label} title={it.hint}>
              <span>{it.label} <b style={{ color: it.count > 0 ? "#cf1322" : undefined }}>{it.count}</b></span>
            </Tooltip>
          ))}
          <span>C 级长尾（不参与直出）<b>{b.tierC}</b></span>
          <Link href="/master/supply-params?blockedOnly=1">去补录周期主数据（只看阻塞）→</Link>
        </Space>
      }
    />
  );
}

export default function PilotClient({ canManage }: { canManage: boolean }) {
  const { message, modal } = App.useApp();
  const listState = useListState({ key: "replenish-pilot", defaults: { q: "", tier: "", eligibleOnly: "1", pilotOnly: "" }, defaultPageSize: 50 });
  const { filters, page, pageSize } = listState;
  const [model, setModel] = useState<PilotModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [building, setBuilding] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setLoadError(null);
    try {
      setModel(await fetchJson<PilotModel>(`/api/replenish/pilot${refresh ? "?refresh=1" : ""}`));
    } catch (e) {
      setModel(null);
      setLoadError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (!model) return [];
    const q = filters.q.trim().toLowerCase();
    return model.rows.filter((r) =>
      (!filters.tier || r.tier === filters.tier)
      && (filters.eligibleOnly !== "1" || r.eligible)
      && (filters.pilotOnly !== "1" || r.pilot)
      && (!q || r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)),
    );
  }, [model, filters.q, filters.tier, filters.eligibleOnly, filters.pilotOnly]);
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  const build = () => {
    modal.confirm({
      title: "固化本期分层与权责",
      content: "按当前分层页口径（近 6 月销量、S/A/B/C 切点、XYZ、异动、周期主数据）写入本月 sku_planning_policy；已有的人工覆写与试点标记保留。",
      okText: "固化",
      cancelText: "取消",
      onOk: async () => {
        setBuilding(true);
        try {
          const res = await postJson<{ period: string; total: number; inserted: number; updated: number; overridesKept: number; byOwnership: Record<string, number>; blockers: BuildBlockers }>("/api/planning/policy", { action: "build" });
          const direct = res.byOwnership?.supply_chain_direct ?? 0;
          const b = res.blockers;
          message.success(
            `已固化 ${res.period}：${res.total} 个 SKU（新增 ${res.inserted} / 更新 ${res.updated}，保留覆写 ${res.overridesKept}）；供应链直出 ${direct}`
            + (b ? `，S/A/B ${b.candidates} 中阻塞：周期未维护 ${b.leadDaysUnknown} / 样本不足 ${b.xyzNull} / 波动 Y-Z ${b.xyzNotX} / 异动 ${b.detectorHit}` : ""),
            6,
          );
          await load(true);
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          setBuilding(false);
        }
      },
    });
  };

  const setPilot = async (pilot: boolean) => {
    if (!model?.period) { message.warning("尚未固化任何期间，请先「固化本期分层」"); return; }
    try {
      const res = await postJson<{ changed: number; missing: number[] }>("/api/planning/policy", { action: "pilot", period: model.period, skuIds: selected, pilot });
      message.success(`${pilot ? "纳入" : "移出"}试点 ${res.changed} 个${res.missing.length ? `（${res.missing.length} 个未在本期固化，已跳过）` : ""}`);
      setSelected([]);
      await load(true);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const columns: ColumnsType<PilotRow> = [
    { title: "候选", dataIndex: "eligible", width: 80, fixed: "left", render: (v: boolean, r) => v ? <Tag color="green" icon={<CheckCircleOutlined />}>候选</Tag> : <Tooltip title={r.blockers.join("；")}><Tag>阻塞</Tag></Tooltip> },
    { title: "试点", dataIndex: "pilot", width: 70, render: (v: boolean) => (v ? <Tag color="blue">试点</Tag> : "—") },
    { title: "SKU 编码", dataIndex: "code", width: 140, render: (v: string) => <SkuHoverCard code={v} /> },
    { title: "名称", dataIndex: "name", width: 220, ellipsis: true },
    { title: "品牌", dataIndex: "brand", width: 100, render: (v: string | null) => v ?? "—" },
    {
      title: "分层", dataIndex: "tier", width: 90,
      render: (v: Tier, r) => <Tooltip title={r.tierSource === "live" ? "未固化，取分层页实时值" : r.tierSource === "policy_override" ? "本期固化值（人工覆写）" : "本期固化值"}><Tag color={TIER_COLORS[v]}>{v}{r.tierSource === "policy_override" ? "*" : ""}</Tag></Tooltip>,
    },
    { title: "XYZ", dataIndex: "xyz", width: 80, render: (v: string | null, r) => v ? <Tooltip title={`CV ${r.cv}`}><Tag color={XYZ_COLORS[v]}>{v}</Tag></Tooltip> : <Typography.Text type="secondary">样本不足</Typography.Text> },
    { title: "权责", dataIndex: "ownershipLabel", width: 100 },
    { title: "近6月销量", dataIndex: "sales6m", width: 110, align: "right", render: (v: number) => v.toLocaleString("zh-CN") },
    { title: "周期主数据", dataIndex: "leadDaysKnown", width: 100, render: (v: boolean) => (v ? <Tag color="green">已维护</Tag> : <Tag color="red">缺失</Tag>) },
    { title: "异动", dataIndex: "detectorHit", width: 80, render: (v: boolean) => (v ? <Tag color="volcano">命中</Tag> : "—") },
    { title: "阻塞原因", dataIndex: "blockers", width: 240, render: (v: string[]) => (v.length ? v.join("；") : "—") },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>补货试点候选（从稳定 SKU 起）</Typography.Title>
      <CaliberNote
        summary={<>候选 = 生效分层 S/A/B ∧ 需求波动 X ∧ 加工/在途周期已维护 ∧ 无异动命中（= 权责「供应链直出」）。{model ? <>　候选 <b>{model.candidates}</b> / {model.scanned}，占近 6 月销量 <b>{model.candidateSalesSharePct}%</b>。</> : null}</>}
        detail={<div>{(model?.notes ?? []).map((n, i) => <p key={i}>{n}</p>)}{model ? <p>分层期：{model.period ?? "未固化"}；销量窗口 {model.months[0]} ~ {model.months[model.months.length - 1]}；读模型生成于 {model.builtAt.slice(0, 16).replace("T", " ")}。</p> : null}</div>}
      />
      {model && !model.period ? (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="尚未固化任何期间的分层（sku_planning_policy 为空）——分层暂按实时值显示；点击「固化本期分层」后才能标记试点。" />
      ) : null}
      {model ? <WhyDirectZero model={model} /> : null}
      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col span={4}><Statistic title="候选 SKU" value={model?.candidates ?? "—"} suffix={model ? `/ ${model.scanned}` : undefined} /></Col>
        <Col span={4}><Statistic title="候选销量占比" value={model?.candidateSalesSharePct ?? "—"} suffix="%" /></Col>
        <Col span={4}><Statistic title="已标记试点" value={model?.pilotMarked ?? "—"} suffix={model ? `/ ${model.pilotSalesSharePct}% 销量` : undefined} /></Col>
        <Col span={4}><Statistic title="S/A/B 缺周期" value={model?.blockers.leadMissing ?? "—"} valueStyle={{ color: model && model.blockers.leadMissing > 0 ? "#cf1322" : undefined }} /></Col>
        <Col span={4}><Statistic title="S/A/B 波动 Y/Z" value={model ? model.blockers.xyzNotX + model.blockers.xyzUnclassified : "—"} /></Col>
        <Col span={4}><Statistic title="S/A/B 异动命中" value={model?.blockers.detectorHit ?? "—"} /></Col>
      </Row>
      <ListToolbar
        state={listState}
        extra={
          <>
            <Select
              placeholder="分层"
              allowClear
              style={{ width: 100 }}
              value={filters.tier || undefined}
              options={(["S", "A", "B", "C"] as Tier[]).map((t) => ({ value: t, label: `${t} 级${model ? `（${model.byTier[t].eligible}/${model.byTier[t].total}）` : ""}` }))}
              onChange={(v) => listState.setFilter({ tier: v ?? "" })}
            />
            <span>只看候选 <Switch size="small" checked={filters.eligibleOnly === "1"} onChange={(v) => listState.setFilter({ eligibleOnly: v ? "1" : "" })} /></span>
            <span>只看试点 <Switch size="small" checked={filters.pilotOnly === "1"} onChange={(v) => listState.setFilter({ pilotOnly: v ? "1" : "" })} /></span>
            <SearchInput allowClear placeholder="搜索 SKU 编码/名称" style={{ width: 200 }} onSearch={(v) => listState.setFilter({ q: v.trim() })} />
          </>
        }
        primaryActions={
          <Space>
            {canManage ? <Button type="primary" icon={<ThunderboltOutlined />} loading={building} onClick={build}>固化本期分层</Button> : null}
            {canManage ? <Button disabled={selected.length === 0} onClick={() => void setPilot(true)}>纳入试点（{selected.length}）</Button> : null}
            {canManage ? <Button disabled={selected.length === 0} onClick={() => void setPilot(false)}>移出试点</Button> : null}
            <Button icon={<ReloadOutlined />} onClick={() => void load(true)}>重算</Button>
          </Space>
        }
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="试点候选" />
      <Table<PilotRow>
        rowKey="skuId"
        size={listState.tableSize}
        columns={columns}
        dataSource={pageRows}
        loading={loading}
        scroll={{ x: "max-content" }}
        rowSelection={canManage ? { selectedRowKeys: selected, onChange: (keys) => setSelected(keys.map(Number)), preserveSelectedRowKeys: true } : undefined}
        pagination={listState.paginationProps({ total: filtered.length })}
        locale={{ emptyText: loadError ? "数据未加载" : "当前条件下没有 SKU" }}
      />
    </div>
  );
}
