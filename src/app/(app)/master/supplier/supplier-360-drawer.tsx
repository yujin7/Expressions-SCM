"use client";

/**
 * 供应商 360（主数据页每行的只读抽屉）。
 *
 * 事故背景：`/master/supplier` 长期是纯 CRUD——编码、名称、联系人、执照到期日。
 * 「这家供应商到底怎么样」（准时率、交期、质检、价格异动、账期、历史观察）散在五张报表里，
 * 采购在维护档案时一个也看不到，于是分级、账期、加不加单全靠印象。
 *
 * 本抽屉**不新增任何口径**：四个既有读模型各取该供应商那一行并排摆出来
 * （装配层 `server/modules/master/supplier-360.ts`，接口 `/api/master/supplier/[id]/360`）。
 * - 金额（采购额 / 降本）由服务端按 PRICE_VISIBLE_ROLES 剥离，这里只按 `moneyVisible` 显示或标「无权限」；
 * - 「历史交期观察」明确标 observation_only：只观察，不改主数据、不改阈值；
 * - 每块右上角给回源链接，数字不做死胡同。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Card, Col, Descriptions, Drawer, Empty, Row, Space, Spin, Statistic, Tag, Tooltip, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";
import { formatQty, formatYuan } from "@/components/format";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { SUPPLIER_KIND_LABELS, SUPPLIER_STATUS_COLORS, SUPPLIER_STATUS_LABELS } from "@/components/labels";
import type { Supplier360 } from "@/server/modules/master/supplier-360";

const PAYMENT_TERM_TYPE_LABELS: Record<string, string> = { prepay: "预付", on_delivery: "款到发货", monthly_credit: "月结" };
const ATTAINMENT_LABELS: Record<string, string> = {
  attained: "已达标", below_target: "未达标", not_credit: "非账期", unknown: "未知",
};
const CONFIDENCE_LABELS: Record<string, string> = { high: "高", medium: "中", low: "低" };

/** 0–1 比率 → 百分数文案；null（无样本/未测量）→ 「—」而不是 0.0% */
const ratePct = (v: number | null | undefined, digits = 1): string => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
const days = (v: number | null | undefined): string => (v == null ? "—" : `${v} 天`);
/** 金额：无权限（服务端已剥离）与「本年没有采购」是两回事，必须分开说 */
const money = (v: string | null | undefined, visible: boolean): string =>
  (visible ? formatYuan(v) : "无权限");

function SectionTitle({ title, href, hint }: { title: string; href: string; hint: string }) {
  return (
    <Space size={8} wrap>
      <Typography.Text strong>{title}</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text>
      <Typography.Link href={href} style={{ fontSize: 12 }}>查看完整报表 →</Typography.Link>
    </Space>
  );
}

export default function Supplier360Drawer({
  supplierId,
  onClose,
}: {
  supplierId: number | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<Supplier360 | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (supplierId == null) return;
    setLoading(true);
    setLoadError(null);
    try {
      setData(await fetchJson<Supplier360>(`/api/master/supplier/${supplierId}/360`));
    } catch (e) {
      setData(null);
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => {
    if (supplierId == null) { setData(null); setLoadError(null); return; }
    void load();
  }, [supplierId, load]);

  const s = data?.supplier;
  const sc = data?.scorecard.row ?? null;
  const po = data?.purchaseOrders.row ?? null;
  const pt = data?.paymentTerm.row ?? null;
  const lh = data?.leadHistory.row ?? null;
  const latestSpend = pt?.spend?.[pt.spend.length - 1] ?? null;

  return (
    <Drawer
      title={s ? `供应商 360 — ${s.code} ${s.name}` : "供应商 360"}
      width={880}
      open={supplierId != null}
      onClose={onClose}
      destroyOnHidden
    >
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="供应商 360" retrying={loading} />
      {loading && !data ? (
        <div style={{ textAlign: "center", padding: 40 }}><Spin /></div>
      ) : null}

      {data && s ? (
        <Space direction="vertical" size={14} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="只读汇总：本抽屉不写任何数据，四块内容各自来自既有读模型，口径以各自报表为准。"
            description="金额（采购额 / 降本）仅采购 / 生产计划 / 财务 / 管理员可见；「历史交期观察」为外部观察值，只观察不改主数据。"
          />

          <Descriptions size="small" column={3} bordered items={[
            { key: "code", label: "编码", children: s.code },
            {
              key: "status", label: "状态",
              children: <Tag color={SUPPLIER_STATUS_COLORS[s.status]}>{SUPPLIER_STATUS_LABELS[s.status] ?? s.status}</Tag>,
            },
            { key: "level", label: "档案等级", children: s.level ?? "—" },
            {
              key: "kinds", label: "类型",
              children: s.kinds.length > 0 ? s.kinds.map((k) => <Tag key={k}>{SUPPLIER_KIND_LABELS[k] ?? k}</Tag>) : "—",
            },
            {
              key: "term", label: "账期",
              children: s.paymentTermType
                ? `${PAYMENT_TERM_TYPE_LABELS[s.paymentTermType] ?? s.paymentTermType}${s.creditDays != null ? ` ${s.creditDays} 天` : ""}${s.paymentTermEffectiveFrom ? `（${s.paymentTermEffectiveFrom} 起）` : ""}`
                : (s.paymentTerm ?? "—"),
            },
            {
              key: "capacity", label: "申报月产能",
              children: s.declaredMonthlyCapacity ? `${formatQty(s.declaredMonthlyCapacity)} ${s.capacityUom ?? ""}`.trim() : "—",
            },
          ]} />

          {/* ── 记分卡：OTIF / 质检 / 价格异动 ── */}
          <Card size="small" title={
            <SectionTitle
              title="记分卡（准时 × 质检 × 价格异动）"
              hint={`窗口 ${data.scorecard.windowDays} 天；样本 < ${data.scorecard.minSamples} 张收货单不评级`}
              href={data.links.scorecard}
            />
          }>
            {sc ? (
              <>
                <Row gutter={[10, 10]} className="compact-kpi-row">
                  <Col><Card size="small"><Statistic title="综合分" value={sc.score ?? "—"} suffix={sc.grade ? ` / ${sc.grade}` : ""} /></Card></Col>
                  <Col><Card size="small"><Statistic title="准时率 OTIF" value={ratePct(sc.onTimeRate)} /></Card></Col>
                  <Col><Card size="small"><Statistic title="质检合格率" value={ratePct(sc.qcPassRate)} /></Card></Col>
                  <Col><Card size="small"><Statistic title="让步接收率" value={ratePct(sc.concessionRate)} /></Card></Col>
                  <Col><Card size="small"><Statistic title="报废率" value={ratePct(sc.scrapRate)} /></Card></Col>
                  <Col><Card size="small"><Statistic title="价格变更次数" value={sc.priceChangeCount} /></Card></Col>
                </Row>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
                  样本 {sc.sampleN} 张生效收货单；置信度 {CONFIDENCE_LABELS[sc.confidence] ?? sc.confidence}。{sc.reason}
                  {sc.suggestLevelChange ? <Tag color="orange" style={{ marginLeft: 6 }}>建议复核等级</Tag> : null}
                </Typography.Paragraph>
              </>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`窗口内（近 ${data.scorecard.windowDays} 天）没有该供应商的收货/质检/价格信号，不评分`} />
            )}
          </Card>

          {/* ── 采购订单指标（当年） ── */}
          <Card size="small" title={
            <SectionTitle
              title={`采购订单指标（${data.purchaseOrders.year} 年）`}
              hint={`截至 ${data.purchaseOrders.asOf}`}
              href={data.links.purchaseOrders}
            />
          }>
            {po ? (
              <Row gutter={[10, 10]} className="compact-kpi-row">
                <Col><Card size="small"><Statistic title="已下单 PO" value={po.poCount} suffix="单" /></Card></Col>
                <Col><Card size="small"><Statistic title="下单数量（基础单位）" value={formatQty(po.orderedBaseQty)} /></Card></Col>
                <Col>
                  <Card size="small">
                    <Statistic title="未税采购额" value={money(po.netAmount, data.purchaseOrders.moneyVisible)} />
                  </Card>
                </Col>
                <Col>
                  <Card size="small">
                    <Statistic
                      title={<Tooltip title="下单 → 首次收货的中位天数；样本不足时不给分位数"><span>订单至交付 P50</span></Tooltip>}
                      value={po.cycle.insufficient ? "样本不足" : days(po.cycle.firstP50)}
                    />
                  </Card>
                </Col>
                <Col><Card size="small"><Statistic title="订单至交付 P90" value={po.cycle.insufficient ? "样本不足" : days(po.cycle.firstP90)} /></Card></Col>
                <Col>
                  <Card size="small">
                    <Statistic
                      title={<Tooltip title={`可判 ${po.otif.evaluable} 单：命中 ${po.otif.hit} / 未达 ${po.otif.miss}；未到期 ${po.otif.pending}、缺承诺交期 ${po.otif.unevaluable} 不进分母`}><span>OTIF</span></Tooltip>}
                      value={ratePct(po.otif.rate)}
                    />
                  </Card>
                </Col>
                <Col><Card size="small"><Statistic title="年内降本" value={money(po.costSaving.savingYtd, data.purchaseOrders.moneyVisible)} /></Card></Col>
                <Col><Card size="small"><Statistic title="年内涨价" value={money(po.costSaving.increaseYtd, data.purchaseOrders.moneyVisible)} /></Card></Col>
              </Row>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`${data.purchaseOrders.year} 年没有该供应商的已下单采购订单`} />
            )}
          </Card>

          {/* ── 账期候选 ── */}
          <Card size="small" title={
            <SectionTitle
              title="账期与采购额名次"
              hint={`${data.paymentTerm.year} 年，截至 ${data.paymentTerm.asOf}`}
              href={data.links.paymentTerm}
            />
          }>
            {pt ? (
              <Descriptions size="small" column={3} items={[
                { key: "pool", label: "供应商池", children: pt.pool },
                {
                  key: "term", label: "账期类型",
                  children: pt.paymentTermType
                    ? `${PAYMENT_TERM_TYPE_LABELS[pt.paymentTermType] ?? pt.paymentTermType}${pt.creditDays != null ? ` ${pt.creditDays} 天` : ""}`
                    : (pt.paymentTermText ?? "未登记"),
                },
                { key: "attain", label: "账期达成", children: ATTAINMENT_LABELS[pt.attainment] ?? pt.attainment },
                { key: "cand", label: "是否候选", children: <Tooltip title={pt.candidateReason}><span>{pt.candidate ? "是" : "否"}</span></Tooltip> },
                { key: "since", label: "合作起始", children: pt.cooperationSince ?? "—" },
                { key: "years", label: "合作年数", children: pt.cooperationYears == null ? "—" : `${pt.cooperationYears} 年` },
                {
                  key: "spend", label: "采购额（含结算）",
                  children: money(latestSpend?.total, data.paymentTerm.moneyVisible),
                },
                {
                  key: "rank", label: "池内名次",
                  children: latestSpend?.rank == null ? "—" : `第 ${latestSpend.rank} / ${latestSpend.rankOf}`,
                },
                { key: "trend", label: "名次趋势", children: pt.rankTrend },
              ]} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该供应商本年没有采购额记录，不进入账期候选看板" />
            )}
          </Card>

          {/* ── 历史交期观察（observation_only） ── */}
          <Card size="small" title={
            <SectionTitle
              title="历史交期观察"
              hint={`来源 ${data.leadHistory.source}${data.leadHistory.sourceAsOf ? `，截至 ${data.leadHistory.sourceAsOf}` : ""}`}
              href={data.links.leadHistory}
            />
          }>
            <Tag color="default" style={{ marginBottom: 8 }}>
              observation_only · 只观察，不改主数据、不改预警阈值
            </Tag>
            {data.leadHistory.state !== "ready" ? (
              <Alert type="warning" showIcon message="观察数据尚未就绪（同步批次缺失或样本不足），本块不作结论。" />
            ) : lh ? (
              <Row gutter={[10, 10]} className="compact-kpi-row">
                <Col><Card size="small"><Statistic title="观察订单数" value={lh.orders} suffix={`（${lh.ordersWithReceipt} 单有入库）`} /></Card></Col>
                <Col><Card size="small"><Statistic title="观察交期 P50" value={days(lh.observed.p50)} /></Card></Col>
                <Col><Card size="small"><Statistic title="观察交期 P90" value={days(lh.observed.p90)} /></Card></Col>
                <Col>
                  <Card size="small">
                    <Statistic
                      title={<Tooltip title={`有承诺交货日的样本 ${lh.observed.promisedSamples} 条；样本不足 ${data.leadHistory.minSamples} 条时不作结论`}><span>观察准时率</span></Tooltip>}
                      value={ratePct(lh.observed.onTimeRate)}
                    />
                  </Card>
                </Col>
                <Col>
                  <Card size="small">
                    <Statistic
                      title={<Tooltip title="系统学习值（rollup_supplier_lead）按样本加权，仅供与左侧观察值对照">
                        <span>系统学习准时率</span>
                      </Tooltip>}
                      value={ratePct(lh.system?.onTimeRate ?? null)}
                    />
                  </Card>
                </Col>
              </Row>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="外部观察里没有这家供应商（未认领身份或无历史订单）" />
            )}
          </Card>

          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            准入与整改记录见 <Typography.Link href={data.links.lifecycle}>供应商准入与整改</Typography.Link>。
          </Typography.Paragraph>
        </Space>
      ) : null}
    </Drawer>
  );
}
