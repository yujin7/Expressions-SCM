"use client";

/**
 * 补货试点候选（D59 R5）：候选 = 生效分层 S/A/B ∧ XYZ=X ∧ 加工/在途周期已维护 ∧ 无异动命中。
 * 同页提供「固化本期分层」（pmc）与「纳入/移出试点」（pmc）。读模型 replenish-pilot/v2。
 *
 * W12：同页并列「金额口径分层」（近 6 月销量 × 单位成本）与「数量 × 金额」迁移矩阵。
 * 纯对照——候选判定、权责与固化仍只读数量口径分层；成本覆盖率不足时金额列显示「不可用」而非等级。
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
  /** W12 金额口径分层；null = 成本覆盖不足或无成本（不可用，非 C 级） */
  valueTier: Tier | null;
  unitCostSource: "sku_costs" | "finance_observation" | null;
}

/** W12 迁移矩阵（rules/abc.tierMigrationMatrix） */
interface TierMigration {
  cells: { qtyTier: Tier; valueTier: Tier | null; count: number }[];
  agree: number;
  disagree: number;
  insufficient: number;
  total: number;
  agreePct: number | null;
}

interface CostCoverage {
  skus: number;
  skusWithCost: number;
  skuPct: number | null;
  salesWeightedPct: number | null;
  minPct: number;
  state: "ready" | "insufficient";
  reason: string | null;
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
  tierBasis: "qty" | "value";
  tierBasisApplied: "qty";
  costCoverage: CostCoverage;
  tierMigration: TierMigration;
  valueTierLimitations: string[];
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

const TIER_ORDER: Tier[] = ["S", "A", "B", "C"];

/**
 * W12 分层迁移矩阵：行 = 现行数量口径分层，列 = 金额口径分层（销量 × 单位成本）。
 * 对角线 = 两把尺一致；对角线之外 = 换尺后会移动的 SKU；最后一列「不可用」= 成本覆盖不足，
 * **不是 C 级**——把「不知道」画进 C 会直接误导长尾判定，所以它单列且不参与一致率分母。
 */
function TierMigrationCard({ model }: { model: PilotModel }) {
  const m = model.tierMigration;
  const cc = model.costCoverage;
  const cell = (qtyTier: Tier, valueTier: Tier | null): number =>
    m.cells.find((c) => c.qtyTier === qtyTier && c.valueTier === valueTier)?.count ?? 0;
  const insufficient = cc.state !== "ready";
  return (
    <Alert
      type={insufficient ? "warning" : "info"}
      showIcon
      style={{ marginBottom: 12 }}
      message={
        <Space wrap size={[16, 4]}>
          <span>分层口径对照（W12，<b>只对照不生效</b>：候选/权责/固化仍按数量口径）</span>
          <span>声明口径 <Tag>{model.tierBasis === "value" ? "金额（对照）" : "数量"}</Tag>实际生效 <Tag color="blue">数量</Tag></span>
          <span>成本覆盖（按销量加权）<b>{cc.salesWeightedPct ?? "—"}%</b> / 门槛 {cc.minPct}%（有成本 SKU {cc.skusWithCost}/{cc.skus}）</span>
          {insufficient ? null : <span>两把尺一致率 <b>{m.agreePct ?? "—"}%</b>（一致 {m.agree} · 会移动 {m.disagree}）</span>}
        </Space>
      }
      description={
        insufficient ? (
          <div>
            <p style={{ margin: "4px 0" }}>{cc.reason}</p>
            <p style={{ margin: 0 }}>金额口径列全部显示「不可用」，不降级为等级；补齐 SKU 成本（/master 成本上传或财务运营成本观察）后本矩阵自动出现。</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, marginTop: 4 }}>
              <thead>
                <tr>
                  <th style={{ padding: "2px 10px", textAlign: "left" }}>数量 ＼ 金额</th>
                  {TIER_ORDER.map((t) => <th key={t} style={{ padding: "2px 10px" }}>{t}</th>)}
                  <th style={{ padding: "2px 10px" }}>不可用</th>
                </tr>
              </thead>
              <tbody>
                {TIER_ORDER.map((qt) => (
                  <tr key={qt}>
                    <th style={{ padding: "2px 10px", textAlign: "left" }}><Tag color={TIER_COLORS[qt]}>{qt}</Tag></th>
                    {TIER_ORDER.map((vt) => (
                      <td key={vt} style={{ padding: "2px 10px", textAlign: "right", fontWeight: qt === vt ? 600 : 400, color: qt !== vt && cell(qt, vt) > 0 ? "#fa8c16" : undefined }}>
                        {cell(qt, vt)}
                      </td>
                    ))}
                    <td style={{ padding: "2px 10px", textAlign: "right", color: "#8c8c8c" }}>{cell(qt, null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {model.valueTierLimitations.map((n, i) => <p key={i} style={{ margin: "4px 0 0", color: "#8c8c8c" }}>{n}</p>)}
          </div>
        )
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
    {
      title: "金额口径分层", dataIndex: "valueTier", width: 130,
      render: (v: Tier | null, r) => (v
        ? <Tooltip title={`近 6 月销量 × 单位成本（来源 ${r.unitCostSource === "sku_costs" ? "手工成本表" : "财务运营成本观察"}）；只作对照，不驱动候选/权责/固化`}>
          <Tag color={TIER_COLORS[v]}>{v}{v === r.tier ? "" : " ↕"}</Tag>
        </Tooltip>
        : <Tooltip title="成本覆盖率不足门槛，或本 SKU 没有可解析的单位成本——不可用，不是 C 级"><Tag>不可用</Tag></Tooltip>),
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
      {model ? <TierMigrationCard model={model} /> : null}
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
