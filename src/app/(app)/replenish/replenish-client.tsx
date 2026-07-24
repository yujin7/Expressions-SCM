"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Input,
  InputNumber,
  Modal,
  Popover,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import ProjectionDrawer from "@/components/ProjectionDrawer";
import { metricTooltip } from "@/components/metrics";

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
  leadDays: number | null;
  coverFull: number | null;
  refGap: boolean;
  suppressReason: string | null;
  belowLead: boolean;
  heldQty: string | null;
  forecastDaily: number;
  forecastTrend: "up" | "down" | "flat";
  forecastDivergent: boolean;
  safetyQty: number;
  safetyMethod: string;
  shortageDate: string | null;
  daysToShortage: number | null;
  orderByDate: string | null;
  orderWindowMissed: boolean;
  planExplain: string[];
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
  };
}


function SharedPackagingPanel({ skuId }: { skuId: number }) {
  const [items, setItems] = useState<{ materialCode: string; materialName: string; baseUom: string; onHand: string; sharedCount: number; sharedWith: { code: string }[] }[] | null>(null);
  useEffect(() => {
    fetch(`/api/master/sku/${skuId}/shared-packaging`)
      .then((r) => r.json())
      .then((d) => setItems(d.items ?? []))
      .catch(() => setItems([]));
  }, [skuId]);
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

export default function ReplenishClient() {
  const { message } = App.useApp();
  const [coverDays, setCoverDays] = useState<number>(45);
  const [minCover, setMinCover] = useState<number>(30);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState<ReplenishResult | null>(null);
  const [loading, setLoading] = useState(false);

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        coverDaysTarget: String(coverDays || 45),
        minCoverAlert: String(minCover || 30),
        q,
        page: String(page),
        pageSize: String(pageSize),
      });
      const res = await fetchJson<ReplenishResult>(`/api/replenish/suggestions?${params.toString()}`);
      setData(res);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [coverDays, minCover, q, page, pageSize, message]);

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

  const columns: ColumnsType<ReplenishRow> = useMemo(
    () => [
      { title: "SKU 编码", dataIndex: "code", width: 110, fixed: "left" },
      { title: "名称", dataIndex: "name", ellipsis: true },
      { title: "品牌", dataIndex: "brand", width: 100, render: (v: string | null) => v ?? "—" },
      {
        title: "分层", dataIndex: "abcClass", width: 70, align: "center" as const,
        render: (v: string | null, r: ReplenishRow) => v ? <Tooltip title={`ABC ${v} 类——目标覆盖 ${r.effectiveTarget} 天（分层策略，可在运行参数调）`}><Tag color={v === "A" ? "red" : v === "B" ? "orange" : "default"}>{v}</Tag></Tooltip> : "—",
      },
      {
        title: "系统口径（记账+快照）",
        children: [
          { title: "在库", dataIndex: "onHand", width: 95, align: "right" as const, render: (v: number) => v.toLocaleString("zh-CN") },
          { title: "PO 在途", dataIndex: "inTransit", width: 90, align: "right" as const, render: (v: number) => v.toLocaleString("zh-CN") },
        ],
      },
      {
        title: "参考口径（文件登记，只提示不入账）",
        children: [
          {
            title: "存量在途", dataIndex: "legacyTransit", width: 90, align: "right" as const,
            render: (v: number) => (v > 0 ? <Tooltip title="旧流程存量单未入库余量（在途参考·成品跟进表）"><span>{v.toLocaleString("zh-CN")}</span></Tooltip> : "—"),
          },
          {
            title: "在制委外", dataIndex: "wipQty", width: 90, align: "right" as const,
            render: (v: number) => (v > 0 ? <Tooltip title="WO 计划产出（已审批/执行中、未暂停）——成品主要补给来源；执行中单残余部分批已收会略高估"><span style={{ color: "#722ed1" }}>{v.toLocaleString("zh-CN")}</span></Tooltip> : "—"),
          },
          {
            title: "全口径在库", dataIndex: "refQty", width: 105, align: "right" as const,
            render: (v: number | null, r: ReplenishRow) =>
              v == null ? "—" : (
                <Space size={4}>
                  <span>{v.toLocaleString("zh-CN")}</span>
                  {r.refGap ? <Tooltip title="总库存明细（全公司口径）显著高于系统在库——海外/其他部门仓不在系统快照源"><Tag color="orange" style={{ marginInlineEnd: 0 }}>缺口</Tag></Tooltip> : null}
                </Space>
              ),
          },
          { title: "在订未出", dataIndex: "onOrder", width: 90, align: "right" as const, render: (v: number | null) => (v == null || v === 0 ? "—" : v.toLocaleString("zh-CN")) },
          {
            title: "借出未还", dataIndex: "borrowOut", width: 90, align: "right" as const,
            render: (v: number) => (v > 0 ? <Tooltip title="已借给其他渠道，不再是自己可卖库存——已从全管道口径扣减"><span style={{ color: "#d4380d" }}>-{v.toLocaleString("zh-CN")}</span></Tooltip> : "—"),
          },
        ],
      },
      {
        title: "销速与判定",
        children: [
          { title: "日均销", dataIndex: "daily", width: 80, align: "right" as const },
          {
            title: "预测日均", dataIndex: "forecastDaily", width: 100, align: "right" as const,
            render: (v: number, r: ReplenishRow) => {
              const arrow = r.forecastTrend === "up" ? "↑" : r.forecastTrend === "down" ? "↓" : "→";
              const color = r.forecastTrend === "up" ? "#cf1322" : r.forecastTrend === "down" ? "#3f8600" : "#888";
              return (
                <Tooltip title={r.forecastDivergent ? "预测与近3月日均分歧>30%——建议人工复核该 SKU 的需求判断" : "Holt 线性预测（近6月，捕捉趋势）——供人工判断，不驱动建议量"}>
                  <span style={{ color }}>{v} {arrow}{r.forecastDivergent ? " ⚠" : ""}</span>
                </Tooltip>
              );
            },
          },
          {
            title: "可销(系统)", dataIndex: "daysCover", width: 105, align: "right" as const,
            render: (v: number | null, r: ReplenishRow) => {
              const body = v == null ? <Typography.Text type="secondary">无动销</Typography.Text>
                : v < 15 ? <Typography.Text type="danger" strong>{v}</Typography.Text> : <span>{v}</span>;
              return (
                <Space size={4}>
                  {body}
                  {r.belowLead ? <Tooltip title={`已低于常规生产周期 ${r.leadDays} 天`}><Tag color="red" style={{ marginInlineEnd: 0 }}>低于周期</Tag></Tooltip> : null}
                </Space>
              );
            },
          },
          {
            title: "可销(全管道)", dataIndex: "coverFull", width: 100, align: "right" as const,
            render: (v: number | null) => (v == null ? "—" : <Tooltip title="（max(系统在库, 全口径参考) + PO在途 + 存量在途 + 在订未出）÷ 日均销"><span>{v}</span></Tooltip>),
          },
          { title: "生产周期", dataIndex: "leadDays", width: 85, align: "right" as const, render: (v: number | null) => (v == null ? "—" : `${v} 天`) },
        ],
      },
      {
        title: "曲线",
        key: "proj",
        width: 60,
        fixed: "right",
        render: (_: unknown, r: ReplenishRow) => <a onClick={() => setProjSku(r.code)}>查看</a>,
      },
      {
        title: "建议补货量",
        dataIndex: "suggestQty",
        width: 140,
        align: "right",
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
          ) : (
            "—"
          ),
      },
    ],
    [],
  );

  return (
    <div>
      <style>{`.replenish-danger-row td { background: #fff1f0 !important; }`}</style>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        补货建议（R11）
      </Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="建议引擎 v2（逐日推演）：按安全库存与逐日到货推演首次短缺，落在生产周期内才建议下单；建议量=补至「安全库存+目标覆盖」。仍融合全口径参考/存量在途/在制做标注与防重复下单抑制；另融合全口径参考（总库存明细）/存量在途/在订未出与生产周期做风险标注与防重复下单抑制；生成的是草稿，走正常审批（R13 人工闸）。"
        description={
          data?.meta ? (
            <Typography.Text type="secondary">
              销速窗口：{data.meta.months3.length ? data.meta.months3.join("、") : "无销量数据"}
              {data.meta.snapDate ? `；快照数据日期：${data.meta.snapDate}` : ""}
              {data.meta.refDate ? `；全口径参考时点：${data.meta.refDate}（总库存明细，全公司口径——覆盖缺口 SKU 标「缺口」）` : ""}
              ；触发建议 {data.meta.suggestCount} 个 SKU
              {data.meta.suppressedCount > 0 ? `，其中 ${data.meta.suppressedCount} 个因全口径参考充足被抑制（防对海外/其他仓已有库存重复下单，逐行有原因）` : ""}。
            </Typography.Text>
          ) : null
        }
      />
      <Space style={{ marginBottom: 16, display: "flex", justifyContent: "space-between" }} wrap>
        <Space wrap>
          <span>
            目标覆盖天数{" "}
            <InputNumber
              min={1}
              max={365}
              precision={0}
              value={coverDays}
              onChange={(v) => {
                setCoverDays(v ?? 45);
                setPage(1);
              }}
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
              onChange={(v) => {
                setMinCover(v ?? 30);
                setPage(1);
              }}
              style={{ width: 90 }}
            />
          </span>
          <Input.Search
            allowClear
            placeholder="搜索 SKU 编码/名称"
            style={{ width: 220 }}
            onSearch={(value) => {
              setQ(value.trim());
              setPage(1);
            }}
          />
        </Space>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>
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
              <a href="/outsource/bh">前往备货申请列表提交审批 →</a>
            </span>
          }
        />
      ) : null}
      <Table<ReplenishRow>
        rowKey="skuId"
        size="middle"
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        rowClassName={(r) => (r.daysCover != null && r.daysCover < 15 ? "replenish-danger-row" : "")}
        rowSelection={{
          selectedRowKeys: selectedRows.map((r) => r.skuId),
          preserveSelectedRowKeys: true,
          onChange: (_keys, rows) => setSelectedRows(rows.filter((r) => r != null)),
          getCheckboxProps: (r) => ({ disabled: r.suggestQty == null && r.heldQty == null }),
        }}
        expandable={{
          rowExpandable: (r) => (r as { skuId?: number }).skuId != null,
          expandedRowRender: (r) => <SharedPackagingPanel skuId={(r as { skuId: number }).skuId} />,
        }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />
      <div
        style={{
          position: "sticky",
          bottom: 0,
          padding: "12px 0",
          background: "var(--ant-color-bg-container, #fff)",
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
            { title: "名称", dataIndex: "name", ellipsis: true },
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
    </div>
  );
}