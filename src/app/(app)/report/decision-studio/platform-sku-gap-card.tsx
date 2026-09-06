"use client";

/**
 * 天猫平台 SKU 身份缺口（按销售额排序）+ 一键认领。
 *
 * 放在决策工作室「平台身份覆盖」标签里：身份控制塔告诉你"覆盖率 46.7%"，
 * 这张卡告诉你**先补哪 60 个**、每个值多少钱、系统猜它是谁。
 * 候选只是建议；认领必须由人选定目标 SKU 后提交，写路径在服务端做冲突与权限校验。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, Col, Modal, Progress, Row, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson, postJson } from "@/components/fetchJson";
import RemoteSelect from "@/components/RemoteSelect";
import { VISUAL_COLOR } from "@/components/decision-visuals";
import type { PlatformSkuGapStatus } from "@/server/modules/report/platform-sku-identity-gap";
import type { PlatformSkuIdentityView, PlatformSkuIdentityRowView as PlatformSkuGapRow } from "@/server/modules/report/platform-sku-identity-view";
import { identityBulkKey, identityBulkPayload, identityBulkReport, mergeIdentityBulk, unconfirmedIdentityBulk, type IdentityBulkItem, type IdentityBulkKind, type IdentityBulkReport } from "./identity-bulk-result";
import { identityBulkReview, type IdentityReviewItem } from "./identity-bulk-review";

const STATUS_LABEL: Record<PlatformSkuGapStatus, { text: string; color: string }> = {
  mapped: { text: "已映射", color: "success" },
  direct_claimed: { text: "已认领", color: "success" },
  crosswalk_conflict: { text: "对照表冲突", color: "error" },
  crosswalk_without_code: { text: "对照表无编码", color: "warning" },
  barcode_claim_pending: { text: "条码待认领", color: "processing" },
  not_in_crosswalk: { text: "不在对照表", color: "error" },
  bundle_resolved: { text: "组合装（已拆到组件）", color: "geekblue" },
};

function yuan(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

export default function PlatformSkuGapCard({ active }: { active: boolean }) {
  const { message } = App.useApp();
  const [data, setData] = useState<PlatformSkuIdentityView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<PlatformSkuGapRow | null>(null);
  const [targetSkuId, setTargetSkuId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [reviewData, setReviewData] = useState<PlatformSkuIdentityView | null>(null);
  const [bulkReport, setBulkReport] = useState<IdentityBulkReport | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [retryReview, setRetryReview] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const canClaim = data?.permissions.canClaim === true;
  const canSeeAmounts = data?.permissions.canSeeAmounts === true;

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchJson<PlatformSkuIdentityView>("/api/report/platform-sku-identity-gap", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setData(next);
    } catch (e) {
      if (!controller.signal.aborted) setLoadError((e as Error).message);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (active && !data) void load();
  }, [active, data, load]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const openClaim = (row: PlatformSkuGapRow, presetSkuId?: number) => {
    if (!canClaim || loading || loadError || savingRef.current) return;
    setReviewData(data);
    setClaiming(row);
    setTargetSkuId(presetSkuId ?? null);
  };

  const submitClaim = async () => {
    if (!canClaim || savingRef.current) return;
    if (!claiming || !targetSkuId) {
      message.warning("请先选择目标 SKU");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await postJson<{ readModels: "refreshed" | "deferred" }>("/api/master/sku/platform-claim", {
        shopName: claiming.shopName,
        platformSkuId: claiming.platformSkuId,
        skuId: targetSkuId,
      });
      if (result.readModels === "refreshed") {
        message.success("已认领；覆盖率与外部需求信号已按新身份重建");
      } else {
        message.warning("认领已保存，派生统计待重建；请勿为了刷新统计重复认领");
      }
      setClaiming(null);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const [reviewKind, setReviewKind] = useState<IdentityBulkKind | null>(null);
  const bulkReview = identityBulkReview(reviewKind ?? "tmall", reviewData);
  const openReview = (kind: IdentityBulkKind) => {
    if (!canClaim || !data || loading || loadError || savingRef.current) return;
    setReviewData(data); // Immutable fetch result: preview and submitted items share this snapshot.
    setReviewKind(kind);
  };
  const submitBatch = async (kind: IdentityBulkKind, items: IdentityBulkItem[], previous?: IdentityBulkReport) => {
    if (!canClaim || savingRef.current || !items.length) return;
    items = items.map(({ skuId, skuCode, shopName, platformSkuId, barcode }) => ({ skuId, skuCode, shopName, platformSkuId, barcode }));
    savingRef.current = true;
    setSaving(true);
    let next: IdentityBulkReport;
    try {
      const response = await postJson<unknown>(
        kind === "barcode" ? "/api/master/sku/barcode-fill/bulk" : "/api/master/sku/platform-claim/bulk",
        identityBulkPayload(kind, items),
      );
      next = identityBulkReport(kind, items, response);
      if (next.rows.some(row => row.status === "rejected" || row.status === "unconfirmed") || next.readModels === "deferred") {
        message.warning("批次有待处理事项，请查看逐行结果");
      } else message.success("本批已完成，逐行结果已保留");
    } catch {
      next = unconfirmedIdentityBulk(kind, items);
      message.error("结果未确认；请先核对当前归属，勿重复提交");
    }
    setBulkReport(mergeIdentityBulk(previous, next));
    setRetryReview(false);
    setResultOpen(true);
    setReviewKind(null);
    savingRef.current = false;
    setSaving(false);
    // The write is settled (or explicitly uncertain); a slow read refresh must not trap the result modal.
    void load();
  };
  const rejectedRows = bulkReport?.rows.filter(row => row.status === "rejected") ?? [];
  const unconfirmedCount = bulkReport?.rows.filter(row => row.status === "unconfirmed").length ?? 0;
  const completedCount = bulkReport?.rows.filter(row => row.status === "saved" || row.status === "unchanged").length ?? 0;
  const resultSummary = `本批 ${bulkReport?.rows.length ?? 0} 项：已完成 ${completedCount} · 被拒绝 ${rejectedRows.length} · 结果未确认 ${unconfirmedCount}`;

  const columns: ColumnsType<PlatformSkuGapRow> = [
    {
      title: "店铺 / 平台 SKU",
      key: "id",
      width: 230,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{r.shopName}</Typography.Text>
          <Typography.Text type="secondary" copyable={{ text: r.platformSkuId }}>{r.platformSkuId}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "商品 / 规格",
      key: "name",
      ellipsis: true,
      render: (_, r) => (
        <Space direction="vertical" size={0} style={{ maxWidth: 360 }}>
          <Typography.Text ellipsis={{ tooltip: r.productName ?? "" }}>{r.productName ?? "（未提供）"}</Typography.Text>
          <Typography.Text type="secondary">{r.skuName ?? "—"}{r.specToken ? ` · ${r.specToken}` : ""}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "支付金额",
      key: "paidAmount",
      dataIndex: "paidAmount",
      width: 110,
      align: "right",
      sorter: (a, b) => Number(a.paidAmount) - Number(b.paidAmount),
      defaultSortOrder: "descend",
      render: (v: string) => <Typography.Text strong>¥{yuan(v)}</Typography.Text>,
    },
    {
      title: "件数 / 退款",
      key: "qty",
      width: 110,
      align: "right",
      render: (_, r) => `${r.paidQty.toLocaleString("zh-CN")} / ${r.refundQty.toLocaleString("zh-CN")}`,
    },
    {
      title: "最近售出",
      dataIndex: "lastSoldDate",
      width: 110,
      render: (v: string | null, r) => v ? <span>{v} <Typography.Text type="secondary">({r.activeDays}天)</Typography.Text></span> : "—",
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 120,
      render: (v: PlatformSkuGapStatus, row: PlatformSkuGapRow) => (
        <Space direction="vertical" size={0}>
          <Tag color={STATUS_LABEL[v].color}>{STATUS_LABEL[v].text}</Tag>
          {row.bundleComponents?.length ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.bundleComponents.map((c) => `${c.skuCode}×${c.qty}`).join(" + ")}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "系统建议（仅供核对）",
      key: "candidates",
      width: 330,
      render: (_, r) => r.candidates.length === 0 ? (
        <Typography.Text type="secondary">无相似成品</Typography.Text>
      ) : (
        <Space direction="vertical" size={2}>
          {r.candidates.map((c) => (
            <Space key={c.skuId} size={6} wrap>
              <Tag color={c.score >= 80 ? "green" : c.score >= 60 ? "gold" : "default"}>{c.score}</Tag>
              <Typography.Text>{c.code}</Typography.Text>
              <Typography.Text type="secondary" ellipsis={{ tooltip: `${c.name} — ${c.reasons.join("；")}` }} style={{ maxWidth: 160 }}>
                {c.name}
              </Typography.Text>
              {canClaim ? <Button size="small" type="link" disabled={loading || !!loadError || saving} onClick={() => openClaim(r, c.skuId)}>认领为此</Button> : null}
            </Space>
          ))}
        </Space>
      ),
    },
    {
      title: "操作",
      key: "action",
      width: 90,
      fixed: "right",
      render: (_, r) => r.status === "crosswalk_conflict"
        ? <Typography.Text type="danger">先裁决对照表</Typography.Text>
        : <Button size="small" onClick={() => openClaim(r)}>手动认领</Button>,
    },
  ];

  const totals = data?.totals;
  return (
    <Card
      size="small"
      title={canSeeAmounts ? "平台 SKU 身份缺口 · 按价值排序" : "平台 SKU 身份缺口 · 核对队列"}
      extra={
        <Space wrap>
          <Tag color="warning">观察口径</Tag>
          {canClaim ? <Button
            size="small"
            type="primary"
            disabled={!data?.exactHits.length || loading || !!loadError || saving}
            onClick={() => openReview("tmall")}
          >
            一键认领精确命中 ({data ? data.exactHits.length : "—"})
          </Button> : null}
          {canClaim ? <Button size="small" disabled={!data?.pddExactHits?.length || loading || !!loadError || saving} onClick={() => openReview("pdd")}>
            拼多多精确命中 ({data ? data.pddExactHits?.length ?? 0 : "—"})
          </Button> : null}
          {canClaim ? <Button size="small" disabled={!data?.barcodeFillHits?.length || loading || !!loadError || saving} onClick={() => openReview("barcode")}>
            补齐条码 ({data ? data.barcodeFillHits?.length ?? 0 : "—"})
          </Button> : null}
          <Button size="small" onClick={() => void load()} loading={loading} disabled={saving}>刷新</Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        {bulkReport ? <Alert type={rejectedRows.length || unconfirmedCount || bulkReport.readModels !== "refreshed" ? "warning" : "success"}
          showIcon message={resultSummary}
          action={<Button size="small" onClick={() => { setRetryReview(false); setResultOpen(true); }}>查看处理结果</Button>} /> : null}
        {loadError ? (
          <Alert
            type="error"
            showIcon
            message="平台 SKU 身份缺口加载失败"
            description={loadError}
            action={<Button size="small" onClick={() => void load()}>重试</Button>}
          />
        ) : null}
        <Alert
          type={loadError ? "error" : data?.state === "ready" ? "info" : "warning"}
          showIcon
          message={loadError ? "本区块数据未加载" : data?.gate ?? "加载中…"}
          description={data ? `批次截至 ${data.sourceAsOf?.slice(0, 10) ?? "—"}，销售日 ${data.window.from ?? "—"} ～ ${data.window.to ?? "—"}；对照表截至 ${data.crosswalkAsOf?.slice(0, 10) ?? "—"}。` : undefined}
        />
        {!canSeeAmounts && data ? <Alert type="info" showIcon message="当前角色可核对身份与数量；销售金额及金额覆盖比例受权限保护。" /> : null}
        {!canClaim && data ? <Typography.Text type="secondary">认领与条码补齐需计划、采购或仓库负责人操作。</Typography.Text> : null}
        {canSeeAmounts ? <Row gutter={[10, 10]} className="compact-kpi-row">
          <Col xs={12} lg={6}>
            <Card size="small">
              <Statistic
                title="按金额的身份覆盖"
                value={totals?.mappedAmountPct ?? "数据不足"}
                suffix={totals?.mappedAmountPct == null ? undefined : "%"}
                valueStyle={{ color: (totals?.mappedAmountPct ?? 0) >= 80 ? VISUAL_COLOR.positive : VISUAL_COLOR.warning }}
              />
              {totals?.mappedAmountPct != null ? <Progress percent={totals.mappedAmountPct} size="small" showInfo={false} /> : null}
              <Typography.Text type="secondary">
                {totals && data?.bundleSummary
                  ? `含组合装拆解后 ${totals.effectiveAmountPct == null ? "—" : `${totals.effectiveAmountPct}%`}（${data.bundleSummary.platformSkus} 个平台 SKU 拆到组件）`
                  : "—"}
              </Typography.Text>
            </Card>
          </Col>
          <Col xs={12} lg={6}>
            <Card size="small">
              <Statistic title="未映射销售额" value={totals ? `¥${yuan(totals.unmappedPaidAmount)}` : "—"} valueStyle={{ color: VISUAL_COLOR.warning }} />
              <Typography.Text type="secondary">共 ¥{totals ? yuan(totals.paidAmount) : "—"}</Typography.Text>
            </Card>
          </Col>
          <Col xs={12} lg={6}>
            <Card size="small">
              <Statistic
                title="不在对照表的平台 SKU"
                value={totals ? totals.byStatus.not_in_crosswalk.skus : "—"}
                suffix={totals ? `/ ${totals.platformSkus}` : undefined}
              />
              <Typography.Text type="secondary">金额 ¥{totals ? yuan(totals.byStatus.not_in_crosswalk.paidAmount) : "—"}</Typography.Text>
            </Card>
          </Col>
          <Col xs={12} lg={6}>
            <Card size="small">
              <Statistic
                title="若采纳全部建议可达"
                value={totals?.coverableAmountPct ?? "数据不足"}
                suffix={totals?.coverableAmountPct == null ? undefined : "%"}
              />
              <Typography.Text type="secondary">{totals ? `${totals.unmappedWithCandidates} 个缺口有候选` : "—"}</Typography.Text>
            </Card>
          </Col>
        </Row> : <Row gutter={[10, 10]} className="compact-kpi-row">
          <Col xs={12}><Statistic title="已映射 / 平台 SKU" value={totals ? `${totals.mappedSkus} / ${totals.platformSkus}` : "—"} /></Col>
          <Col xs={12}><Statistic title="有候选的身份缺口" value={totals?.unmappedWithCandidates ?? "—"} /></Col>
        </Row>}
        <Table<PlatformSkuGapRow>
          rowKey={(r) => `${r.shopName}|${r.platformSkuId}`}
          size="small"
          loading={loading}
          columns={columns.filter((column) => (canSeeAmounts || column.key !== "paidAmount") && (canClaim || column.key !== "action"))}
          dataSource={data?.top ?? []}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          scroll={{ x: 1400 }}
        />
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {(data?.limitations ?? []).map((l) => <div key={l}>· {l}</div>)}
        </Typography.Paragraph>
      </Space>
      <Modal
        title={reviewKind === "barcode" ? "补齐 SKU 条码 · 核对来源" : `批量认领 · ${reviewKind === "pdd" ? "拼多多" : "天猫"}身份核对`}
        open={reviewKind != null}
        width={820}
        styles={{ body: { maxHeight: "60vh", overflowY: "auto" } }}
        onOk={() => { if (reviewKind) return submitBatch(bulkReview.kind, bulkReview.items); }}
        onCancel={() => { if (!savingRef.current) setReviewKind(null); }}
        confirmLoading={saving}
        closable={!saving}
        keyboard={!saving}
        cancelButtonProps={{ disabled: saving }}
        okButtonProps={{ disabled: !canClaim || !bulkReview.items.length }}
        maskClosable={false}
        destroyOnHidden
        okText={`确认${reviewKind === "barcode" ? "写入" : "认领"} ${bulkReview.items.length} 项`}
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            {reviewKind === "barcode"
              ? `候选来自简道云里的财务货品档案或聚水潭商品资料镜像；单来源与双来源一致逐行标明。仅补系统空白条码，不覆盖现有值。另有 ${reviewData?.barcodeFillSummary?.conflicts ?? 0} 个冲突项不在本批，需人工裁决。`
              : reviewKind === "pdd"
                ? "按店铺 + 商品ID + 商家编码核对归属；候选可能来自商家编码同码或商品成本标准翻译。确认后登记拼多多外部身份。"
                : "请核对店铺、平台 SKU 与系统 SKU。候选来自对照表、单品日报或单组件组合装，依据逐行标明；外部身份不会自动认领。"}
          </Typography.Paragraph>
          <div>
            <Typography.Text strong>本批 {bulkReview.items.length} 项 / 候选共 {bulkReview.total} 项</Typography.Text>
            <div><Typography.Text type="secondary">其余 {bulkReview.omitted} 项本批不提交。分页仅切换显示，确认将提交本批全部 {bulkReview.items.length} 项。</Typography.Text></div>
          </div>
          <Table<IdentityReviewItem>
            data-testid="identity-bulk-review"
            key={reviewKind}
            size="small"
            rowKey={row => identityBulkKey(bulkReview.kind, row)}
            dataSource={bulkReview.items}
            pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true, simple: true }}
            tableLayout="fixed"
            columns={[
              { title: "身份 / 目标 / 依据", responsive: ["xs"], render: (_, row) => <div style={{ overflowWrap: "anywhere" }}>
                <strong>{row.skuCode}</strong>
                {row.name ? <div>{row.name}</div> : null}
                <div style={{ marginTop: 4 }}>{row.barcode ?? `${row.shopName} · ${row.platformSkuId}`}</div>
                <div style={{ marginTop: 6 }}><Typography.Text type="secondary">{row.sourceLabel}</Typography.Text></div>
                {canSeeAmounts && reviewKind === "tmall" ? <div>支付金额 ¥{yuan(row.paidAmount)}</div> : null}
              </div> },
              { title: reviewKind === "barcode" ? "条码" : "店铺 / 外部身份", responsive: ["sm"], width: "34%", render: (_, row) => <div style={{ overflowWrap: "anywhere" }}>
                {row.barcode ?? <><div>{row.shopName}</div><div>{row.platformSkuId}</div></>}
              </div> },
              { title: "目标系统 SKU", responsive: ["sm"], width: "26%", render: (_, row) => <div style={{ overflowWrap: "anywhere" }}>
                <strong>{row.skuCode}</strong>{row.name ? <div>{row.name}</div> : null}
              </div> },
              { title: "匹配依据", responsive: ["sm"], render: (_, row) => <span style={{ overflowWrap: "anywhere" }}>{row.sourceLabel}</span> },
              ...(canSeeAmounts && reviewKind === "tmall" ? [{ title: "支付金额", responsive: ["sm" as const], width: 100, dataIndex: "paidAmount", align: "right" as const, render: (v: string | undefined) => `¥${yuan(v)}` }] : []),
            ]}
          />
        </Space>
      </Modal>
      <Modal
        title={retryReview ? "复核未完成项 · 确认后才重试" : "批量处理结果"}
        open={resultOpen}
        width={820}
        onCancel={() => { if (!savingRef.current) { setResultOpen(false); setRetryReview(false); } }}
        closable={!saving}
        keyboard={!saving}
        maskClosable={false}
        footer={<Space wrap>
          <Button disabled={saving} onClick={() => { setResultOpen(false); setRetryReview(false); }}>关闭</Button>
          {rejectedRows.length > 0 && !retryReview ? <Button disabled={saving || loading || !!loadError || !canClaim}
            onClick={() => { if (!savingRef.current && !loading && !loadError && canClaim) setRetryReview(true); }}>复核未完成项</Button> : null}
          {retryReview ? <Button type="primary" loading={saving} disabled={!canClaim || loading || !!loadError || !rejectedRows.length}
            onClick={() => { if (!loading && !loadError && bulkReport) void submitBatch(bulkReport.kind, rejectedRows.map(row => row.item), bulkReport); }}>
            确认重试 {rejectedRows.length} 项
          </Button> : null}
        </Space>}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Alert showIcon type={rejectedRows.length || unconfirmedCount ? "warning" : "success"} message={resultSummary}
            description={retryReview ? "请先处理下列拒绝原因，并再次核对目标 SKU。只重试本表项目；已完成及结果未确认项不会重发。"
              : "结果保留在本页面，关闭窗口后仍可查看；刷新或离开页面后请到身份主档与审计记录核对。"} />
          {unconfirmedCount ? <Alert type="warning" showIcon message="结果未确认不等于失败"
            description="网络中断或服务器异常可能发生在保存之后。这些项目不提供批量重试，请先核对当前归属与审计记录。" /> : null}
          {bulkReport?.readModels !== "refreshed" ? <Alert type="info" showIcon message="派生统计尚未确认更新"
            description="已保存项不需要重复提交；覆盖率与外部需求统计需要后续成功重建，页面刷新不保证完成重建。" /> : null}
          <Table data-testid="identity-bulk-results" size="small"
            rowKey={row => identityBulkKey(bulkReport?.kind ?? "tmall", row.item)}
            dataSource={retryReview ? rejectedRows : bulkReport?.rows ?? []}
            pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }} tableLayout="fixed"
            columns={[
              { title: "项目 / 下一步", responsive: ["xs"], render: (_, row) => <div style={{ overflowWrap: "anywhere" }}>
                <strong>{row.item.skuCode}</strong>
                <div style={{ marginTop: 4 }}>{row.item.barcode ?? `${row.item.shopName} · ${row.item.platformSkuId}`}</div>
                <div style={{ marginTop: 6 }}>{row.detail}</div>
              </div> },
              { title: "目标 SKU", responsive: ["sm"], width: 150, render: (_, row) => <span style={{ overflowWrap: "anywhere" }}>{row.item.skuCode}</span> },
              { title: "外部身份 / 条码", responsive: ["sm"], width: 220, render: (_, row) => <span style={{ overflowWrap: "anywhere" }}>{row.item.barcode ?? `${row.item.shopName} · ${row.item.platformSkuId}`}</span> },
              { title: "结果", width: 96, render: (_, row) => <Tag color={row.status === "rejected" ? "error" : row.status === "unconfirmed" ? "warning" : "success"}>
                {{ saved: "已保存", unchanged: "已一致", rejected: "被拒绝", unconfirmed: "未确认" }[row.status]}
              </Tag> },
              { title: "说明 / 下一步", responsive: ["sm"], render: (_, row) => <span style={{ overflowWrap: "anywhere" }}>{row.detail}</span> },
            ]} />
        </Space>
      </Modal>
      <Modal
        title="认领平台 SKU 到系统 SKU"
        open={claiming != null}
        onOk={() => void submitClaim()}
        onCancel={() => { if (!savingRef.current) setClaiming(null); }}
        confirmLoading={saving}
        closable={!saving}
        keyboard={!saving}
        cancelButtonProps={{ disabled: saving }}
        okButtonProps={{ disabled: !canClaim }}
        maskClosable={false}
        okText="确认认领"
        cancelText="取消"
        destroyOnHidden
      >
        {claiming ? (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              <Typography.Text strong>{claiming.shopName}</Typography.Text> · {claiming.platformSkuId}
              <br />
              {claiming.productName ?? "（未提供）"} {claiming.skuName ? `· ${claiming.skuName}` : ""}
              <br />
              <Typography.Text type="secondary">销售窗口 {reviewData?.window.from ?? "—"} ～ {reviewData?.window.to ?? "—"}；{canSeeAmounts ? `支付金额 ¥${yuan(claiming.paidAmount)}，` : ""}{claiming.paidQty} 件</Typography.Text>
            </Typography.Paragraph>
            <RemoteSelect
              api="/api/master/sku?type=finished"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              placeholder="选择目标系统 SKU（成品）"
              value={targetSkuId ?? undefined}
              disabled={saving}
              onChange={(v) => setTargetSkuId(typeof v === "number" ? v : Number(v) || null)}
              style={{ width: "100%" }}
            />
            <Alert
              type="warning"
              showIcon
              message="认领即登记外部身份（scope JIANDAOYUN:TMALL），外部需求信号会立刻按它归属；同一平台 SKU 已属于别的系统 SKU 时会被拒绝，需先人工裁决。"
            />
          </Space>
        ) : null}
      </Modal>
    </Card>
  );
}
