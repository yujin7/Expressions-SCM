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
import type {
  PlatformSkuGapRow,
  PlatformSkuGapStatus,
  PlatformSkuIdentityGap,
} from "@/server/modules/report/platform-sku-identity-gap";

const STATUS_LABEL: Record<PlatformSkuGapStatus, { text: string; color: string }> = {
  mapped: { text: "已映射", color: "success" },
  direct_claimed: { text: "已认领", color: "success" },
  crosswalk_conflict: { text: "对照表冲突", color: "error" },
  crosswalk_without_code: { text: "对照表无编码", color: "warning" },
  barcode_claim_pending: { text: "条码待认领", color: "processing" },
  not_in_crosswalk: { text: "不在对照表", color: "error" },
  bundle_resolved: { text: "组合装（已拆到组件）", color: "geekblue" },
};

function yuan(value: string | number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

export default function PlatformSkuGapCard({ active }: { active: boolean }) {
  const { message } = App.useApp();
  const [data, setData] = useState<PlatformSkuIdentityGap | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<PlatformSkuGapRow | null>(null);
  const [targetSkuId, setTargetSkuId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchJson<PlatformSkuIdentityGap>("/api/report/platform-sku-identity-gap", {
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
    setClaiming(row);
    setTargetSkuId(presetSkuId ?? null);
  };

  const submitClaim = async () => {
    if (!claiming || !targetSkuId) {
      message.warning("请先选择目标 SKU");
      return;
    }
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
        message.warning("认领已保存，但统计刷新未完成；页面将立即重试");
      }
      setClaiming(null);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const [bulkOpen, setBulkOpen] = useState(false);
  const [pddBulkOpen, setPddBulkOpen] = useState(false);
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  const submitBarcodeFill = async () => {
    if (!data?.barcodeFillHits?.length) return;
    setSaving(true);
    try {
      const r = await postJson<{ filled: number; unchanged: number; conflicts: number; readModels: "refreshed" | "deferred" }>(
        "/api/master/sku/barcode-fill/bulk",
        { items: data.barcodeFillHits.slice(0, 500).map((h) => ({ skuId: h.skuId, barcode: h.barcode })), source: "jiandaoyun-master-mirror" },
      );
      const summary = `本批补齐条码 ${r.filled} 个，已一致 ${r.unchanged}，冲突 ${r.conflicts}`;
      if (r.readModels === "refreshed") message.success(summary);
      else message.warning(`${summary}；统计刷新未完成，页面将立即重试`);
      setBarcodeOpen(false);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const submitPddBulk = async () => {
    if (!data?.pddExactHits?.length) return;
    setSaving(true);
    try {
      const r = await postJson<{ total: number; claimed: number; alreadyClaimed: number; failed: number; readModels: "refreshed" | "deferred" }>(
        "/api/master/sku/platform-claim/bulk",
        { items: data.pddExactHits.slice(0, 300).map((h) => ({ shopName: h.shopName, platformSkuId: h.platformSkuId, skuId: h.skuId, platform: "pdd" })) },
      );
      const summary = `拼多多本批 ${r.total} 行：新认领 ${r.claimed}，此前已认领 ${r.alreadyClaimed}，失败 ${r.failed}`;
      if (r.readModels === "refreshed") message.success(summary);
      else message.warning(`${summary}；统计刷新未完成，页面将立即重试`);
      setPddBulkOpen(false);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const submitBulk = async () => {
    if (!data?.exactHits.length) return;
    setSaving(true);
    try {
      const r = await postJson<{ total: number; claimed: number; alreadyClaimed: number; failed: number; readModels: "refreshed" | "deferred" }>(
        "/api/master/sku/platform-claim/bulk",
        { items: data.exactHits.slice(0, 300).map((h) => ({ shopName: h.shopName, platformSkuId: h.platformSkuId, skuId: h.skuId })) },
      );
      const summary = `本批 ${r.total} 行：新认领 ${r.claimed}，此前已认领 ${r.alreadyClaimed}，失败 ${r.failed}`;
      if (r.readModels === "refreshed") message.success(summary);
      else message.warning(`${summary}；统计刷新未完成，页面将立即重试`);
      setBulkOpen(false);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

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
              <Button size="small" type="link" onClick={() => openClaim(r, c.skuId)}>认领为此</Button>
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
      title="平台 SKU 身份缺口 · 按价值排序"
      extra={
        <Space>
          <Tag color="warning">观察口径</Tag>
          <Button
            size="small"
            type="primary"
            disabled={!data?.exactHits.length}
            onClick={() => setBulkOpen(true)}
          >
            一键认领精确命中 ({data ? data.exactHits.length : "—"})
          </Button>
          <Button size="small" disabled={!data?.pddExactHits?.length} onClick={() => setPddBulkOpen(true)}>
            拼多多精确命中 ({data ? data.pddExactHits?.length ?? 0 : "—"})
          </Button>
          <Button size="small" disabled={!data?.barcodeFillHits?.length} onClick={() => setBarcodeOpen(true)}>
            补齐条码 ({data ? data.barcodeFillHits?.length ?? 0 : "—"})
          </Button>
          <Button size="small" onClick={() => void load()} loading={loading}>刷新</Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
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
        <Row gutter={[10, 10]} className="compact-kpi-row">
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
        </Row>
        <Table<PlatformSkuGapRow>
          rowKey={(r) => `${r.shopName}|${r.platformSkuId}`}
          size="small"
          loading={loading}
          columns={columns}
          dataSource={data?.top ?? []}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          scroll={{ x: 1400 }}
        />
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {(data?.limitations ?? []).map((l) => <div key={l}>· {l}</div>)}
        </Typography.Paragraph>
      </Space>
      <Modal
        title="补齐 SKU 条码：财务货品档案 / 聚水潭商品资料镜像"
        open={barcodeOpen}
        onOk={() => void submitBarcodeFill()}
        onCancel={() => setBarcodeOpen(false)}
        confirmLoading={saving}
        maskClosable={false}
        okText={`确认写入 ${Math.min(500, data?.barcodeFillHits?.length ?? 0)} 个条码`}
        cancelText="取消"
      >
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            系统 {data?.barcodeFillSummary?.activeSkus ?? 0} 个启用 SKU 里只有 {data?.barcodeFillSummary?.skusWithBarcode ?? 0} 个有条码。
            这些候选来自简道云里财务「货品档案」与聚水潭「商品资料」镜像，两来源一致、系统字段空白、条码未被其它 SKU 占用；
            另有 {data?.barcodeFillSummary?.conflicts ?? 0} 个冲突项不在此列，需人工裁决。
            条码是天猫/唯品会对照表与同步身份解析的通用键，补齐后后续同步会自动解析更多外部行。
          </Typography.Paragraph>
          <Table
            size="small"
            rowKey="skuId"
            dataSource={(data?.barcodeFillHits ?? []).slice(0, 8)}
            pagination={false}
            columns={[
              { title: "系统 SKU", dataIndex: "skuCode", width: 130 },
              { title: "名称", dataIndex: "skuName", ellipsis: true },
              { title: "条码", dataIndex: "barcode", width: 150 },
              { title: "来源", dataIndex: "source", width: 90, render: (v: string) => (v === "both" ? "财务+聚水潭" : v === "jst_mirror" ? "聚水潭" : "财务") },
            ]}
          />
          {(data?.barcodeFillHits?.length ?? 0) > 8 ? <Typography.Text type="secondary">…仅预览前 8 行，每次最多写入 500 个</Typography.Text> : null}
        </Space>
      </Modal>
      <Modal
        title="批量认领：拼多多对照表商家编码 = 系统编码"
        open={pddBulkOpen}
        onOk={() => void submitPddBulk()}
        onCancel={() => setPddBulkOpen(false)}
        confirmLoading={saving}
        maskClosable={false}
        okText={`确认认领 ${Math.min(300, data?.pddExactHits?.length ?? 0)} 行`}
        cancelText="取消"
      >
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            拼多多没有 SKU 级销量表，订单按「店铺 + 商品ID + 商家编码」归属。对照表里这些商家编码与系统编码逐字相等；
            确认后登记为 JIANDAOYUN:PDD 外部身份，拼多多订单件数才会进入外部销速。
          </Typography.Paragraph>
          <Typography.Text>
            对照表 {data?.pddSummary?.crosswalkRows ?? 0} 行，含商家编码 {data?.pddSummary?.merchantCodes ?? 0}，精确命中 {data?.pddSummary?.exactCodes ?? 0}，
            经「商品成本标准」翻译命中 {data?.pddSummary?.bridgedCodes ?? 0}，已认领 {data?.pddSummary?.claimed ?? 0}。
          </Typography.Text>
          <Table
            size="small"
            rowKey={(h) => `${h.shopName}|${h.platformSkuId}`}
            dataSource={(data?.pddExactHits ?? []).slice(0, 8)}
            pagination={false}
            columns={[
              { title: "商品ID|商家编码", dataIndex: "platformSkuId", width: 200 },
              { title: "→ 系统 SKU", dataIndex: "skuCode", width: 120 },
              { title: "线索", dataIndex: "source", width: 96, render: (v: string) => (v === "cost_standard" ? <Tag color="purple">成本标准</Tag> : <Tag>同码</Tag>) },
              { title: "商品", dataIndex: "productName", ellipsis: true },
            ]}
          />
        </Space>
      </Modal>
      <Modal
        title="批量认领：对照表商家编码 = 系统编码"
        open={bulkOpen}
        onOk={() => void submitBulk()}
        onCancel={() => setBulkOpen(false)}
        confirmLoading={saving}
        maskClosable={false}
        okText={`确认认领 ${Math.min(300, data?.exactHits.length ?? 0)} 行`}
        cancelText="取消"
      >
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            这些平台 SKU 在简道云对照表里的「商家编码」与系统 SKU 编码逐字相等，但按治理规则外部码不会自动认领。
            确认后逐行登记外部身份并写审计（每次最多 300 行，超出请再点一次）。
          </Typography.Paragraph>
          <Typography.Text>
            共 <Typography.Text strong>{data?.exactHits.length ?? 0}</Typography.Text> 行，
            涉及支付金额占比 <Typography.Text strong>{data?.exactHitAmountPct ?? "—"}%</Typography.Text>。
          </Typography.Text>
          <Table
            size="small"
            rowKey={(h) => `${h.shopName}|${h.platformSkuId}`}
            dataSource={(data?.exactHits ?? []).slice(0, 8)}
            pagination={false}
            columns={[
              { title: "平台 SKU", dataIndex: "platformSkuId", width: 150 },
              { title: "→ 系统 SKU", dataIndex: "skuCode", width: 140 },
              { title: "支付金额", dataIndex: "paidAmount", align: "right", render: (v: string) => `¥${yuan(v)}` },
            ]}
          />
          {(data?.exactHits.length ?? 0) > 8 ? <Typography.Text type="secondary">…仅预览前 8 行</Typography.Text> : null}
        </Space>
      </Modal>
      <Modal
        title="认领平台 SKU 到系统 SKU"
        open={claiming != null}
        onOk={() => void submitClaim()}
        onCancel={() => setClaiming(null)}
        confirmLoading={saving}
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
              <Typography.Text type="secondary">4 个月支付金额 ¥{yuan(claiming.paidAmount)}，{claiming.paidQty} 件</Typography.Text>
            </Typography.Paragraph>
            <RemoteSelect
              api="/api/master/sku?type=finished"
              getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
              placeholder="选择目标系统 SKU（成品）"
              value={targetSkuId ?? undefined}
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
