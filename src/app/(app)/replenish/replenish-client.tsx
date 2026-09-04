"use client";

import SearchInput from "@/components/SearchInput";
import ListToolbar from "@/components/ListToolbar";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Alert,
  App,
  Button,
  Input,
  InputNumber,
  Modal,
  Popover,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType, TableProps } from "antd/es/table";
import { ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import ProjectionDrawer from "@/components/ProjectionDrawer";
import CaliberNote from "@/components/CaliberNote";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import { DECLINE_REASON_LABELS, type DeclineReasonCode } from "@/lib/replenish-decline-reasons";
import { metricTooltip } from "@/components/metrics";
import DeclineSuggestionModal, { type DeclineResult, type DeclineTarget } from "./decline-modal";

interface ReplenishRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  baseUom: string;
  onHand: number;
  inTransit: number;
  daily: number;
  daysCover: number | null;
  suggestQty: string | null;
  refQty: number | null;
  onOrder: number | null;
  legacyTransit: number;
  wipQty: number;
  borrowOut: number;
  abcClass: "A" | "B" | "C" | null;
  effectiveTarget: number;
  /** W3：目标覆盖天数来自哪一层（页面/分域参数/ABC 分层/全局） */
  targetBasis: {
    value: number;
    source: "user" | "sku" | "brand" | "segment" | "global" | "abc_a" | "abc_b" | "abc_c";
    scope: string | null;
    abcClass: "A" | "B" | "C" | null;
    label: string;
  };
  /** W3：安全库存兜底天数命中的分域层 */
  safetyDaysBasis: { value: number; layer: "sku" | "brand" | "segment" | "global" | "fallback"; scope: string; label: string };
  /** W3：没有建议时的结构化原因 */
  noSuggestReason: { code: string; label: string; text: string } | null;
  /** D58 四档（最近固化期，含覆写）；null = 未固化 */
  tier: "S" | "A" | "B" | "C" | null;
  tierOverridden: boolean;
  /** D59 权责 */
  ownership: "supply_chain_direct" | "joint_review" | "ops_fallback" | null;
  ownershipLabel: string | null;
  pilot: boolean;
  planEventTags: string[];
  leadDays: number | null;
  productionLeadDays: number | null;
  logisticsLeadDays: number | null;
  coverFull: number | null;
  refGap: boolean;
  suppressReason: string | null;
  belowLead: boolean;
  heldQty: string | null;
  forecastDaily: number;
  forecastTrend: "up" | "down" | "flat";
  forecastDivergent: boolean;
  forecastTrusted: boolean;
  /** B7：该 SKU 的预测误差（滚动回测） */
  forecastAccuracy: { samples: number; wape: number | null; bias: number | null; fva: number | null; reliable: boolean };
  /** W5：当日已复核并放弃（服务端权威，全员可见） */
  declinedToday: { by: string; at: string; reason: string; reasonCode: DeclineReasonCode; businessDate: string } | null;
  safetyQty: number;
  safetyMethod: string;
  shortageDate: string | null;
  daysToShortage: number | null;
  orderByDate: string | null;
  orderWindowMissed: boolean;
  planExplain: string[];
  externalDaily30: number | null;
  externalDaily30Gate: string | null;
  externalLastSold: string | null;
}

interface ReplenishResult {
  rows: ReplenishRow[];
  total: number;
  meta: {
    coverDaysTarget: number;
    minCoverAlert: number;
    months3: string[];
    snapDate: string | null;
    suggestCount: number;
    refDate: string | null;
    suppressedCount: number;
    engine: string;
    serviceLevel: number;
    policyPeriod: string | null;
    hiddenTierC: number;
    ownershipMix: Record<"supply_chain_direct" | "joint_review" | "ops_fallback", number>;
  };
}

interface PlanEventRow {
  id: number;
  kindLabel: string;
  channelName: string | null;
  startDate: string;
  endDate: string | null;
  expectedUpliftPct: number | null;
  note: string | null;
  createdBy: string | null;
  phase: "upcoming" | "active" | "past";
}

const TIER_COLORS: Record<string, string> = { S: "magenta", A: "red", B: "orange", C: "default" };
/** W3 目标覆盖天数来源的短标签（完整解释在 tooltip 的 targetBasis.label 里） */
const TARGET_SOURCE_TAG: Record<string, string> = {
  user: "页面",
  sku: "SKU 覆盖",
  brand: "品牌覆盖",
  segment: "分层覆盖",
  global: "全局",
  abc_a: "A 类",
  abc_b: "B 类",
  abc_c: "C 类",
};
const OWNERSHIP_COLORS: Record<string, string> = { supply_chain_direct: "green", joint_review: "gold", ops_fallback: "default" };
const TIER_OPTIONS = [
  { value: "S", label: "S 级" }, { value: "A", label: "A 级" }, { value: "B", label: "B 级" }, { value: "C", label: "C 级" }, { value: "none", label: "未固化" },
];
const OWNERSHIP_OPTIONS = [
  { value: "supply_chain_direct", label: "供应链直出" }, { value: "joint_review", label: "联合评审" }, { value: "ops_fallback", label: "运营按需" },
];

type ReplenishSortBy =
  | "code"
  | "name"
  | "brand"
  | "abcClass"
  | "tier"
  | "ownership"
  | "onHand"
  | "inTransit"
  | "legacyTransit"
  | "wipQty"
  | "refQty"
  | "onOrder"
  | "borrowOut"
  | "daily"
  | "externalDaily30"
  | "forecastDaily"
  | "daysCover"
  | "coverFull"
  | "leadDays"
  | "suggestQty";

type ReplenishSortOrder = "ascend" | "descend";

/* 闭环审计 #12 / W5：「不采纳」的权威状态由服务端下发（row.declinedToday，取自审计台账，全员可见）。
   sessionStorage 只留作**乐观提示**：点完到下一次拉取之间先把标打上，拉取回来即以服务端为准。 */
const DECLINED_STORE = "replenish:declined";
function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}
function loadDeclinedToday(): Record<number, DeclineResult> {
  try {
    const raw = sessionStorage.getItem(DECLINED_STORE);
    if (!raw) return {};
    const today = shanghaiToday();
    const out: Record<number, DeclineResult> = {};
    for (const v of Object.values(JSON.parse(raw) as Record<string, DeclineResult>)) {
      if (v && v.businessDate === today) out[v.skuId] = v;
    }
    return out;
  } catch {
    return {};
  }
}
function saveDeclined(map: Record<number, DeclineResult>): void {
  try {
    sessionStorage.setItem(DECLINED_STORE, JSON.stringify(map));
  } catch {
    // 存储不可用（隐私模式等）时只保留内存态
  }
}


function SharedPackagingPanel({ skuId }: { skuId: number }) {
  const [items, setItems] = useState<{ materialCode: string; materialName: string; baseUom: string; onHand: string; sharedCount: number; sharedWith: { code: string }[] }[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setItems(null);
    setLoadError(null);
    try {
      const data = await fetchJson<{ items?: { materialCode: string; materialName: string; baseUom: string; onHand: string; sharedCount: number; sharedWith: { code: string }[] }[] }>(
        `/api/master/sku/${skuId}/shared-packaging`,
      );
      setItems(data.items ?? []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "包材信息加载失败");
    }
  }, [skuId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (loadError) {
    return (
      <Alert
        type="error"
        showIcon
        message="包材信息加载失败"
        description={loadError}
        action={<Button size="small" onClick={() => void load()}>重试</Button>}
      />
    );
  }
  if (items == null) return <Typography.Text type="secondary">载入包材信息…</Typography.Text>;
  if (items.length === 0) return <Typography.Text type="secondary">该成品无生效 BOM 包材（或 BOM 未生效）</Typography.Text>;
  return (
    <Space direction="vertical" size={4} style={{ padding: "4px 0" }}>
      <Typography.Text strong style={{ fontSize: 12 }}>包材可用量（D36 共用包材口径，实时账）：</Typography.Text>
      {items.map((it) => (
        <Typography.Text key={it.materialCode} style={{ fontSize: 12 }}>
          {it.materialCode} {it.materialName}：在库 <b>{formatQty(it.onHand)}</b> {it.baseUom}
          {it.sharedCount > 0 ? (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              　⚠ 与 {it.sharedCount} 个成品共用（{it.sharedWith.slice(0, 4).map((s) => s.code).join("、")}{it.sharedCount > 4 ? "…" : ""}）
            </Typography.Text>
          ) : null}
        </Typography.Text>
      ))}
    </Space>
  );
}

/** D55：运营计划事件只作行上下文，不进公式；受限用户按渠道范围裁剪（API 侧） */
function PlanEventsPanel({ skuId }: { skuId: number }) {
  const [rows, setRows] = useState<PlanEventRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setRows(null);
    setLoadError(null);
    try {
      const data = await fetchJson<{ rows?: PlanEventRow[] }>(`/api/planning/events?skuId=${skuId}&openOnly=1&pageSize=20`);
      setRows(data.rows ?? []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "计划事件加载失败");
    }
  }, [skuId]);
  useEffect(() => { void load(); }, [load]);
  if (loadError) {
    return <Alert type="error" showIcon message="计划事件加载失败" description={loadError} action={<Button size="small" onClick={() => void load()}>重试</Button>} />;
  }
  if (rows == null) return <Typography.Text type="secondary">载入运营计划事件…</Typography.Text>;
  return (
    <Space direction="vertical" size={4} style={{ padding: "4px 0" }}>
      <Typography.Text strong style={{ fontSize: 12 }}>
        运营计划事件（未结束，只作上下文、不改建议量）：
        <Link href="/replenish/reconcile" style={{ marginLeft: 8, fontSize: 12 }}>去提报核对 →</Link>
      </Typography.Text>
      {rows.length === 0 ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>无未结束的计划事件</Typography.Text> : rows.map((e) => (
        <Typography.Text key={e.id} style={{ fontSize: 12 }}>
          <Tag color={e.phase === "active" ? "processing" : "default"} style={{ marginInlineEnd: 4 }}>{e.phase === "active" ? "进行中" : "即将"}</Tag>
          <b>{e.kindLabel}</b> {e.startDate}{e.endDate ? ` ~ ${e.endDate}` : " 起"}
          {e.channelName ? `　渠道 ${e.channelName}` : "　全渠道"}
          {e.expectedUpliftPct != null ? `　预期 ${e.expectedUpliftPct > 0 ? "+" : ""}${e.expectedUpliftPct}%` : ""}
          {e.note ? `　${e.note}` : ""}
          {e.createdBy ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>　（{e.createdBy}）</Typography.Text> : null}
        </Typography.Text>
      ))}
    </Space>
  );
}

export default function ReplenishClient() {
  const { message } = App.useApp();
  const listState = useListState({
    key: "replenish",
    defaults: {
      q: "",
      coverDays: "45",
      minCover: "30",
      sortBy: "coverFull",
      sortOrder: "ascend",
      tier: "",
      ownership: "",
      // D58：C 级默认折叠（运营兜底），需要时手动展开
      hideTierC: "1",
    },
    defaultPageSize: 50,
  });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const coverDays = Number(filters.coverDays) || 45;
  const minCover = Number(filters.minCover) || 30;
  const sortBy = filters.sortBy as ReplenishSortBy;
  const sortOrder = filters.sortOrder as ReplenishSortOrder;
  const tier = filters.tier;
  const ownership = filters.ownership;
  const hideTierC = filters.hideTierC === "1";
  const [data, setData] = useState<ReplenishResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedRows, setSelectedRows] = useState<ReplenishRow[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /* E3-03 重复下单守卫：打开确认框时查近 7 天未结 BH/WO（提示不阻断） */
  const [dupHits, setDupHits] = useState<Record<number, { docType: string; docNo: string; status: string; qty: number; daysAgo: number }[]>>({});
  const openConfirm = useCallback(() => {
    setConfirmOpen(true);
    setDupHits({});
    const ids = selectedRows.map((r) => r.skuId);
    if (ids.length === 0) return;
    fetchJson<{ hitsBySku: Record<number, { docType: string; docNo: string; status: string; qty: number; daysAgo: number }[]> }>(
      `/api/outsource/duplicate-check?skuIds=${ids.join(",")}&days=7`,
    )
      .then((d) => setDupHits(d.hitsBySku ?? {}))
      .catch(() => setDupHits({}));
  }, [selectedRows]);
  const [remark, setRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createdDocNo, setCreatedDocNo] = useState<string | null>(null);
  const [projSku, setProjSku] = useState<string | null>(null);
  // 闭环审计 #12：「不采纳」（pmc/admin；服务端 requireAnyRole 仍是权威）
  const me = useMe();
  const canDecline = hasAnyRole(me, "pmc");
  const [declineTarget, setDeclineTarget] = useState<DeclineTarget | null>(null);
  const [declined, setDeclined] = useState<Record<number, DeclineResult>>({});
  useEffect(() => { setDeclined(loadDeclinedToday()); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({
        coverDaysTarget: String(coverDays || 45),
        minCoverAlert: String(minCover || 30),
        q,
        page: String(page),
        pageSize: String(pageSize),
        sortBy,
        sortOrder,
      });
      if (tier) params.set("tier", tier);
      if (ownership) params.set("ownership", ownership);
      if (hideTierC) params.set("hideTierC", "1");
      const res = await fetchJson<ReplenishResult>(`/api/replenish/suggestions?${params.toString()}`);
      setData(res);
    } catch (e) {
      const text = e instanceof Error ? e.message : "补货建议加载失败";
      setData(null);
      setSelectedRows([]);
      setLoadError(text);
      message.error(text);
    } finally {
      setLoading(false);
    }
  }, [coverDays, minCover, q, page, pageSize, sortBy, sortOrder, tier, ownership, hideTierC, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // 数据刷新后同步勾选：当前页内的行以最新建议量为准，建议消失则剔除；不在当前页的保留（跨页勾选）
  useEffect(() => {
    if (!data) return;
    const byId = new Map(data.rows.map((r) => [r.skuId, r]));
    setSelectedRows((rows) =>
      rows.flatMap((r) => {
        const cur = byId.get(r.skuId);
        if (!cur) return [r];
        return cur.suggestQty == null && cur.heldQty == null ? [] : [cur];
      }),
    );
  }, [data]);

  const handleSubmit = async () => {
    if (selectedRows.length === 0) return;
    setSubmitting(true);
    try {
      const res = await postJson<{ id: number; docNo: string }>("/api/replenish/draft", {
        remark: remark.trim() || undefined,
        items: selectedRows.slice(0, 200).map((r) => ({ skuId: r.skuId, qty: r.suggestQty ?? r.heldQty })),
      });
      setCreatedDocNo(res.docNo);
      setConfirmOpen(false);
      setSelectedRows([]);
      setRemark("");
      message.success(`备货申请草稿已生成：${res.docNo}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const policyPeriod = data?.meta.policyPeriod ?? null;
  const columns: ColumnsType<ReplenishRow> = useMemo(
    () => {
      const sortable = (key: ReplenishSortBy) => ({
        key,
        sorter: true,
        sortDirections: ["ascend", "descend"] as ReplenishSortOrder[],
        sortOrder: sortBy === key ? sortOrder : null,
      });
      return [
      { title: "SKU 编码", dataIndex: "code", width: 120, fixed: "left", ...sortable("code") },
      { title: "名称", dataIndex: "name", width: 280, ellipsis: true, ...sortable("name"), render: (v: string, r: ReplenishRow) => (v === r.code ? <Typography.Text type="secondary">（未命名）</Typography.Text> : v) },
      { title: "品牌", dataIndex: "brand", width: 120, ...sortable("brand"), render: (v: string | null) => v ?? "—" },
      {
        title: "分层", dataIndex: "abcClass", width: 82, align: "center" as const, ...sortable("abcClass"),
        render: (v: string | null, r: ReplenishRow) => v ? <Tooltip title={`ABC ${v} 类——目标覆盖 ${r.effectiveTarget} 天（分层策略，可在运行参数调）`}><Tag color={v === "A" ? "red" : v === "B" ? "orange" : "default"}>{v}</Tag></Tooltip> : "—",
      },
      {
        // W3：目标覆盖天数此前只是「分层」列 tooltip 里的一句话，看不出到底是页面输入、分域覆盖还是分层参数在起作用
        title: "目标天数", dataIndex: "effectiveTarget", width: 96, align: "right" as const,
        render: (v: number, r: ReplenishRow) => (
          <Tooltip
            title={
              <span style={{ whiteSpace: "pre-line" }}>
                {`目标覆盖：${r.targetBasis.label}\n安全库存兜底：${r.safetyDaysBasis.label}\n（优先级：页面指定 > 分域覆盖 sku/品牌/分层 > ABC 分层参数 > 全局缺省）`}
              </span>
            }
          >
            <Space size={2}>
              <span>{v} 天</span>
              <Tag
                color={r.targetBasis.source === "user" ? "blue" : r.targetBasis.source.startsWith("abc_") ? "default" : r.targetBasis.source === "global" ? "default" : "purple"}
                style={{ marginInlineEnd: 0 }}
              >
                {TARGET_SOURCE_TAG[r.targetBasis.source]}
              </Tag>
            </Space>
          </Tooltip>
        ),
      },
      {
        title: "四档", dataIndex: "tier", width: 82, align: "center" as const, ...sortable("tier"),
        render: (v: ReplenishRow["tier"], r: ReplenishRow) => v
          ? (
            <Tooltip title={`${v} 级（${policyPeriod ?? ""} 期固化${r.tierOverridden ? "，人工覆写" : ""}${r.pilot ? "，已纳入试点" : ""}）`}>
              <Space size={2}>
                <Tag color={TIER_COLORS[v]} style={{ marginInlineEnd: 0 }}>{v}{r.tierOverridden ? "*" : ""}</Tag>
                {r.pilot ? <Tag color="cyan" style={{ marginInlineEnd: 0 }}>试点</Tag> : null}
              </Space>
            </Tooltip>
          )
          : <Tooltip title="尚未固化分层（sku_planning_policy 为空或本 SKU 未入本期）——在「补货试点候选」页执行本期固化"><Typography.Text type="secondary">未固化</Typography.Text></Tooltip>,
      },
      {
        title: "权责", dataIndex: "ownership", width: 110, align: "center" as const, ...sortable("ownership"),
        render: (v: ReplenishRow["ownership"], r: ReplenishRow) => v
          ? (
            <Space size={2} wrap>
              <Tag color={OWNERSHIP_COLORS[v]} style={{ marginInlineEnd: 0 }}>{v === "ops_fallback" ? "运营兜底" : r.ownershipLabel}</Tag>
              {r.planEventTags.slice(0, 2).map((t) => <Tag key={t} color="purple" style={{ marginInlineEnd: 0 }}>{t}</Tag>)}
            </Space>
          )
          : "—",
      },
      {
        title: "系统口径",
        children: [
          { title: "在库", dataIndex: "onHand", width: 105, align: "right" as const, ...sortable("onHand"), render: (v: number) => v.toLocaleString("zh-CN") },
          { title: "PO 在途", dataIndex: "inTransit", width: 105, align: "right" as const, ...sortable("inTransit"), render: (v: number) => v.toLocaleString("zh-CN") },
        ],
      },
      {
        title: "参考口径（只提示不入账）",
        children: [
          {
            title: "存量在途", dataIndex: "legacyTransit", width: 105, align: "right" as const, ...sortable("legacyTransit"),
            render: (v: number) => (v > 0 ? <Tooltip title="旧流程存量单未入库余量（在途参考·成品跟进表）"><span>{v.toLocaleString("zh-CN")}</span></Tooltip> : "—"),
          },
          {
            title: "在制委外", dataIndex: "wipQty", width: 105, align: "right" as const, ...sortable("wipQty"),
            render: (v: number) => (v > 0 ? <Tooltip title="WO 计划产出（已审批/执行中、未暂停）——成品主要补给来源；执行中单残余部分批已收会略高估"><span style={{ color: "#722ed1" }}>{v.toLocaleString("zh-CN")}</span></Tooltip> : "—"),
          },
          {
            title: "全口径在库", dataIndex: "refQty", width: 125, align: "right" as const, ...sortable("refQty"),
            render: (v: number | null, r: ReplenishRow) =>
              v == null ? "—" : (
                <Space size={4}>
                  <span>{v.toLocaleString("zh-CN")}</span>
                  {r.refGap ? <Tooltip title="总库存明细（全公司口径）显著高于系统在库——海外/其他部门仓不在系统快照源"><Tag color="orange" style={{ marginInlineEnd: 0 }}>缺口</Tag></Tooltip> : null}
                </Space>
              ),
          },
          { title: "在订未出", dataIndex: "onOrder", width: 105, align: "right" as const, ...sortable("onOrder"), render: (v: number | null) => (v == null || v === 0 ? "—" : v.toLocaleString("zh-CN")) },
          {
            title: "借出未还", dataIndex: "borrowOut", width: 105, align: "right" as const, ...sortable("borrowOut"),
            render: (v: number) => (v > 0 ? <Tooltip title="已借给其他渠道，不再是自己可卖库存——已从全管道口径扣减"><span style={{ color: "#d4380d" }}>-{v.toLocaleString("zh-CN")}</span></Tooltip> : "—"),
          },
        ],
      },
      {
        title: "判定",
        children: [
          { title: "日均销", dataIndex: "daily", width: 95, align: "right" as const, ...sortable("daily") },
          {
            title: "外部日均(30天)", dataIndex: "externalDaily30", width: 125, align: "right" as const, ...sortable("externalDaily30"),
            render: (v: number | null, r: ReplenishRow) => v == null
              ? (
                <Tooltip title={r.externalDaily30Gate ?? "该 SKU 尚无已映射的外部需求"}>
                  <Typography.Text type={r.externalDaily30Gate?.includes("暂不折算") ? "warning" : "secondary"}>
                    {r.externalDaily30Gate?.includes("暂不折算") ? "窗口不足" : "未映射"}
                  </Typography.Text>
                </Tooltip>
              )
              : (
                <Tooltip title={`简道云天猫+拼多多已付款观察近 30 天净需求折日均，最近售出 ${r.externalLastSold ?? "—"}；影子列，不进入建议量`}>
                  <Typography.Text type={r.daily === 0 && v > 0 ? "danger" : v > r.daily * 2 ? "warning" : undefined}>{v}</Typography.Text>
                </Tooltip>
              ),
          },
          {
            title: "预测日均", dataIndex: "forecastDaily", width: 115, align: "right" as const, ...sortable("forecastDaily"),
            render: (v: number, r: ReplenishRow) => {
              const arrow = r.forecastTrend === "up" ? "↑" : r.forecastTrend === "down" ? "↓" : "→";
              const color = r.forecastTrend === "up" ? "#cf1322" : r.forecastTrend === "down" ? "#3f8600" : "#888";
              return (
                <Tooltip
                  title={
                    r.forecastDivergent
                      ? "预测与近3月日均分歧>30%，且该 SKU 的预测已回测优于朴素基准——建议人工复核需求判断"
                      : r.forecastTrusted
                        ? "Holt 线性预测（近6月，捕捉趋势）——供人工判断，不驱动建议量"
                        : "该 SKU 的 Holt 预测经回测不优于「下月＝上月」（多为间歇性需求），仅列出供参考，不据此发偏离告警"
                  }
                >
                  <span style={{ color: r.forecastTrusted ? color : "#bbb" }}>{v} {arrow}{r.forecastDivergent ? " ⚠" : ""}</span>
                </Tooltip>
              );
            },
          },
          {
            // B7：回测本就在引擎里算好（用于门控预测），此前只在内部当开关用，计划员看不到「这条建议该信几分」
            title: <Tooltip title={metricTooltip("wape")}>预测误差</Tooltip>,
            key: "forecastAccuracy",
            width: 120,
            align: "right" as const,
            render: (_: unknown, r: ReplenishRow) => {
              const a = r.forecastAccuracy;
              if (a.wape == null) {
                return (
                  <Tooltip title={`无法回测：${a.samples === 0 ? "历史不足 4 个月，滚动回测起不了测" : "该 SKU 回测期实际销量合计为 0"}——预测列仅供参考`}>
                    <Typography.Text type="secondary">—</Typography.Text>
                  </Tooltip>
                );
              }
              const pct = Math.round(a.wape * 1000) / 10;
              const color = !a.reliable ? "default" : pct <= 30 ? "green" : pct <= 60 ? "gold" : "red";
              return (
                <Tooltip
                  title={
                    <span style={{ whiteSpace: "pre-line" }}>
                      {[
                        metricTooltip("wape"),
                        `本 SKU：WAPE ${pct}%，偏差 ${a.bias == null ? "—" : `${a.bias > 0 ? "+" : ""}${Math.round(a.bias * 1000) / 10}%`}（${a.bias == null ? "无法判定" : a.bias > 0.1 ? "系统性高估，会备多" : a.bias < -0.1 ? "系统性低估，有断货风险" : "无明显系统性偏差"}），回测 ${a.samples} 期`,
                        a.fva == null ? "" : a.fva > 0 ? `优于「下月＝上月」朴素预测 ${Math.round(a.fva * 1000) / 10} 个点` : "不优于「下月＝上月」朴素预测——该 SKU 的预测不宜作为判断依据",
                        a.reliable ? "" : "样本 < 3 期，结论参考价值有限",
                      ].filter(Boolean).join("\n")}
                    </span>
                  }
                >
                  <Tag color={color} style={{ marginInlineEnd: 0 }}>{pct}%{a.reliable ? "" : "?"}</Tag>
                </Tooltip>
              );
            },
          },
          {
            title: "可销（系统）", dataIndex: "daysCover", width: 135, align: "right" as const, ...sortable("daysCover"),
            render: (v: number | null, r: ReplenishRow) => {
              const body = v == null ? <Typography.Text type="secondary">无动销</Typography.Text>
                : v < 15 ? <Typography.Text type="danger" strong>{v}</Typography.Text> : <span>{v}</span>;
              return (
                <Space size={4}>
                  {body}
                  {r.belowLead ? <Tooltip title={`已低于总供应周期 ${r.leadDays} 天`}><Tag color="red" style={{ marginInlineEnd: 0 }}>低于周期</Tag></Tooltip> : null}
                </Space>
              );
            },
          },
          {
            title: "可销（全管道）", dataIndex: "coverFull", width: 145, align: "right" as const, ...sortable("coverFull"),
            render: (v: number | null) => (v == null ? "—" : <Tooltip title="（max(系统在库, 全口径参考) + PO在途 + 存量在途 + 在订未出）÷ 日均销"><span>{v}</span></Tooltip>),
          },
          {
            title: "总供应周期",
            dataIndex: "leadDays",
            width: 125,
            align: "right" as const,
            ...sortable("leadDays"),
            render: (v: number | null, r: ReplenishRow) => (
              v == null
                ? "—"
                : <Tooltip title={`生产 ${r.productionLeadDays ?? "—"} 天 + 物流/调拨 ${r.logisticsLeadDays ?? "未维护（暂按 0）"} 天`}>{v} 天</Tooltip>
            ),
          },
        ],
      },
      {
        title: "建议补货量",
        dataIndex: "suggestQty",
        width: 155,
        align: "right",
        ...sortable("suggestQty"),
        render: (v: string | null, r) =>
          v != null ? (
            <Popover
              trigger="click"
              title="为什么是这个数（计算链）"
              content={
                <div style={{ maxWidth: 460 }}>
                  <ol style={{ paddingLeft: 18, margin: 0 }}>
                    {(r.planExplain ?? []).map((e, i) => (
                      <li key={i} style={{ fontSize: 12, marginBottom: 4 }}>{e}</li>
                    ))}
                  </ol>
                </div>
              }
            >
              <Space size={4} style={{ cursor: "pointer" }}>
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                  {Number(v).toLocaleString("zh-CN")}
                </Tag>
                <Typography.Text type="secondary">{r.baseUom}</Typography.Text>
              </Space>
            </Popover>
          ) : r.suppressReason ? (
            <Tooltip title={`${r.suppressReason}；原始建议 ${Number(r.heldQty ?? 0).toLocaleString("zh-CN")} ${r.baseUom}——核实后可勾选按此量生成草稿`}>
              <Space size={4}>
                <Tag style={{ marginInlineEnd: 0 }}>已抑制</Tag>
                {r.heldQty ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>({Number(r.heldQty).toLocaleString("zh-CN")})</Typography.Text> : null}
              </Space>
            </Tooltip>
          ) : r.noSuggestReason ? (
            <Tooltip title={r.noSuggestReason.text}>
              <Tag style={{ marginInlineEnd: 0, color: "#8c8c8c", borderStyle: "dashed" }}>{r.noSuggestReason.label}</Tag>
            </Tooltip>
          ) : (
            "—"
          ),
      },
      {
        title: "库存曲线",
        key: "proj",
        width: 90,
        align: "center",
        render: (_: unknown, r: ReplenishRow) => <a onClick={() => setProjSku(r.code)}>查看</a>,
      },
      {
        /* W5：放弃状态对**所有人**可见（服务端下发），只有计划员看得到「不采纳」入口 */
        title: "复核",
        key: "decline",
        width: 120,
        align: "center" as const,
        render: (_: unknown, r: ReplenishRow) => {
          // 服务端（审计台账）优先；本地乐观提示只在服务端尚未刷新到时兜底
          const server = r.declinedToday;
          const local = declined[r.skuId];
          if (server || local) {
            const reasonCode = server?.reasonCode ?? local!.reasonCode;
            const label = DECLINE_REASON_LABELS[reasonCode]?.label ?? reasonCode;
            const title = server
              ? `${server.by} 于 ${new Date(server.at).toLocaleString("zh-CN", { hour12: false })} 复核并放弃（${label}）${server.reason ? `：${server.reason}` : ""}；已留痕审计，不进采纳率分母`
              : `本次已提交放弃（${label}），刷新后以服务端记录为准`;
            return (
              <Tooltip title={title}>
                <Tag style={{ marginInlineEnd: 0 }}>{server ? `${server.by} 已放弃` : "今日已放弃（待刷新）"}</Tag>
              </Tooltip>
            );
          }
          if (!canDecline) return "—";
          if (r.suggestQty == null && r.heldQty == null) return "—";
          return (
            <a onClick={() => setDeclineTarget({ skuId: r.skuId, code: r.code, name: r.name, baseUom: r.baseUom, suggestQty: r.suggestQty, heldQty: r.heldQty })}>
              不采纳
            </a>
          );
        },
      },
    ];
    },
    [sortBy, sortOrder, policyPeriod, canDecline, declined],
  );

  const handleTableChange: TableProps<ReplenishRow>["onChange"] = (
    _pagination,
    _tableFilters,
    sorter,
    extra,
  ) => {
    if (extra.action !== "sort" || Array.isArray(sorter)) return;
    const nextSortBy = typeof sorter.columnKey === "string"
      ? sorter.columnKey as ReplenishSortBy
      : "coverFull";
    listState.setFilter({
      sortBy: nextSortBy,
      sortOrder: sorter.order === "descend" ? "descend" : "ascend",
    });
  };

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        补货建议（R11）
      </Typography.Title>
      <CaliberNote
        summary={
          <>逐日推演引擎：断货日落在生产周期内才建议下单，建议量补至「安全库存＋目标覆盖」；生成草稿走审批。
          {data?.meta ? <>　触发 <b>{data.meta.suggestCount}</b> 个建议{data.meta.suppressedCount > 0 ? <>，另 {data.meta.suppressedCount} 个因全口径参考充足被抑制（防重复下单）</> : null}。</> : null}
          {data?.meta ? (data.meta.policyPeriod
            ? <>　分层取 {data.meta.policyPeriod} 期固化{data.meta.hiddenTierC > 0 ? <>，已折叠 <b>{data.meta.hiddenTierC}</b> 个 C 级（运营兜底）</> : null}。</>
            : <>　<Typography.Text type="warning">分层尚未固化</Typography.Text>（四档/权责列为空；请在「补货试点候选」页固化本期）。</>) : null}</>
        }
        detail={
          <div>
            <p>建议引擎 v2：按安全库存与逐日到货推演首次短缺；只有短缺日落在生产周期内才触发建议（更早下单是浪费，更晚来不及）。</p>
            <p>融合参考层做标注与抑制（只提示不入账）：全口径参考（总库存明细）、存量在途（旧流程成品跟进表）、在制委外（WO 计划产出）、在订未出、借出未还、生产周期。覆盖缺口 SKU（参考显著高于系统）触发的建议会被抑制并逐行给出原因，人工核实后可放行。</p>
            <p>看过建议、判断不需要下单时点行上「不采纳」留痕（计划/管理员）：只写审计、不改建议、不开单据；「已复核并放弃」在建议闭环追踪单列，不进采纳率分母。放弃状态由服务端按业务日下发（谁、何时、什么原因），换人换设备都看得到——不再只存在点击者自己的浏览器里。</p>
            <p>每行都能追到「为什么」：目标天数列标出该值来自页面输入、分域覆盖（SKU/品牌/分层）、ABC 分层参数还是全局缺省；没有建议时给出结构化原因（库存充足 / 已抑制 / 无销量历史 / 缺生产周期 / 无动销 / 未到下单窗口），空单元格不再模棱两可；预测误差列给出该 SKU 的滚动回测 WAPE 与偏差，作为「这条建议该信几分」的依据。</p>
            {data?.meta ? (
              <p>
                销速窗口：{data.meta.months3.length ? data.meta.months3.join("、") : "无销量数据"}
                {data.meta.snapDate ? `；快照数据日期：${data.meta.snapDate}` : ""}
                {data.meta.refDate ? `；全口径参考时点：${data.meta.refDate}` : ""}。
              </p>
            ) : null}
          </div>
        }
      />
      <ListToolbar
        state={listState}
        extra={
          <>
            <span>
              目标覆盖天数{" "}
              <InputNumber
                min={1}
                max={365}
                precision={0}
                value={coverDays}
                onChange={(v) => listState.setFilter({ coverDays: String(v ?? 45) })}
                style={{ width: 90 }}
              />
            </span>
            <span>
              预警阈值（天）{" "}
              <InputNumber
                min={1}
                max={365}
                precision={0}
                value={minCover}
                onChange={(v) => listState.setFilter({ minCover: String(v ?? 30) })}
                style={{ width: 90 }}
              />
            </span>
            <Select
              allowClear
              placeholder="四档"
              style={{ width: 100 }}
              value={tier || undefined}
              options={TIER_OPTIONS}
              onChange={(v) => listState.setFilter({ tier: v ?? "" })}
            />
            <Select
              allowClear
              placeholder="权责"
              style={{ width: 120 }}
              value={ownership || undefined}
              options={OWNERSHIP_OPTIONS}
              onChange={(v) => listState.setFilter({ ownership: v ?? "" })}
            />
            <Tooltip title="D58：C 级长尾默认折叠（运营兜底），展开后 C 级行进入列表">
              <span>
                折叠 C 级{" "}
                <Switch size="small" checked={hideTierC} disabled={Boolean(tier)} onChange={(v) => listState.setFilter({ hideTierC: v ? "1" : "0" })} />
              </span>
            </Tooltip>
            <SearchInput
              allowClear
              placeholder="搜索 SKU 编码/名称"
              style={{ width: 220 }}
              onSearch={(value) => { listState.setFilter({ q: value.trim() }); }}
            />
          </>
        }
        primaryActions={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
      />
      {createdDocNo ? (
        <Alert
          type="success"
          showIcon
          closable
          onClose={() => setCreatedDocNo(null)}
          style={{ marginBottom: 16 }}
          message={
            <span>
              备货申请草稿 {createdDocNo} 已生成，
              <Link href="/outsource/bh">前往备货申请列表提交审批 →</Link>
            </span>
          }
        />
      ) : null}
      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="补货建议加载失败"
          description={loadError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Table<ReplenishRow>
        className="replenish-table"
        rowKey="skuId"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        onChange={handleTableChange}
        rowSelection={{
          selectedRowKeys: selectedRows.map((r) => r.skuId),
          preserveSelectedRowKeys: true,
          onChange: (_keys, rows) => setSelectedRows(rows.filter((r) => r != null)),
          getCheckboxProps: (r) => ({ disabled: r.suggestQty == null && r.heldQty == null }),
        }}
        expandable={{
          rowExpandable: (r) => (r as { skuId?: number }).skuId != null,
          expandedRowRender: (r) => (
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <SharedPackagingPanel skuId={(r as { skuId: number }).skuId} />
              <PlanEventsPanel skuId={(r as { skuId: number }).skuId} />
            </Space>
          ),
        }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
        locale={{ emptyText: loadError ? "数据未加载" : "当前条件下没有补货建议" }}
      />
      <div
        style={{
          position: "sticky",
          bottom: 0,
          padding: "10px 16px",
          background: "#fff",
          borderTop: "1px solid #f0f0f0",
          boxShadow: "0 -2px 8px rgba(0,0,0,0.06)",
          zIndex: 5,
          display: "flex",
          justifyContent: "flex-end",
          gap: 12,
          alignItems: "center",
        }}
      >
        <Typography.Text>已选 {selectedRows.length} 项</Typography.Text>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          disabled={selectedRows.length === 0}
          onClick={openConfirm}
        >
          生成备货申请草稿（BH）
        </Button>
      </div>

      <Modal
        title="确认生成备货申请草稿（BH）"
        open={confirmOpen}
        onOk={() => void handleSubmit()}
        onCancel={() => setConfirmOpen(false)}
        confirmLoading={submitting}
        okText="生成草稿"
        cancelText="取消"
        width="min(640px, 100vw)"
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="将按下表建议量生成一张 BH 草稿（不自动提交），提交与审批在备货申请页完成。"
        />
        {Object.keys(dupHits).length > 0 ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={`重复下单提醒：${Object.keys(dupHits).length} 个 SKU 近 7 天已有未结单据`}
            description={
              <div style={{ maxHeight: 160, overflowY: "auto", fontSize: 12 }}>
                {selectedRows
                  .filter((r) => dupHits[r.skuId]?.length)
                  .map((r) => (
                    <div key={r.skuId}>
                      <b>{r.code}</b>：
                      {dupHits[r.skuId].map((h) => `${h.docType} ${h.docNo}（${h.status}，${h.qty.toLocaleString("zh-CN")}，${h.daysAgo} 天前）`).join("；")}
                    </div>
                  ))}
                <div style={{ marginTop: 4, color: "#8c8c8c" }}>仅提示，不阻断——确属追加/分批下单可继续。</div>
              </div>
            }
          />
        ) : null}
        {selectedRows.some((r) => r.suggestQty == null && r.heldQty != null) ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={`注意：所选含 ${selectedRows.filter((r) => r.suggestQty == null && r.heldQty != null).length} 个「被抑制」项（覆盖缺口 SKU）——这些 SKU 系统外仓可能已有库存。请确认已核实全口径库存后再放行，否则可能重复采购。`}
          />
        ) : null}
        {selectedRows.length > 200 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`一张 BH 最多 200 项，当前 ${selectedRows.length} 项——将只生成前 200 项，其余请分批。`}
          />
        ) : null}
        <Table<ReplenishRow>
          rowKey="skuId"
          size="small"
          pagination={false}
          dataSource={selectedRows}
          columns={[
            { title: "SKU 编码", dataIndex: "code", width: 110 },
            { title: "名称", dataIndex: "name", ellipsis: true, render: (v: string, r: ReplenishRow) => (v === r.code ? <Typography.Text type="secondary">（未命名）</Typography.Text> : v) },
            {
              title: "建议补货量",
              dataIndex: "suggestQty",
              width: 130,
              align: "right",
              render: (v: string | null, r) => `${Number(v ?? 0).toLocaleString("zh-CN")} ${r.baseUom}`,
            },
          ]}
          style={{ marginBottom: 12 }}
        />
        <Input.TextArea
          rows={2}
          maxLength={200}
          placeholder="备注（可选，默认注明来源为补货建议页）"
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
        />
      </Modal>
      <ProjectionDrawer skuCode={projSku} open={projSku != null} onClose={() => setProjSku(null)} />
      <DeclineSuggestionModal
        target={declineTarget}
        onCancel={() => setDeclineTarget(null)}
        onDeclined={(r) => {
          setDeclined((m) => {
            const next = { ...m, [r.skuId]: r };
            saveDeclined(next);
            return next;
          });
          setDeclineTarget(null);
        }}
      />
    </div>
  );
}
