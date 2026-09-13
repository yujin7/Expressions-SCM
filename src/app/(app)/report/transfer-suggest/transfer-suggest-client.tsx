"use client";

import SearchInput from "@/components/SearchInput";

/** E3-04 仓间调拨建议：逐仓出库流水代理逐仓需求，盈余仓 → 缺口仓贪心分配（只读，不自动开单） */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Input, Modal, Select, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { useMe, hasAnyRole, type Me } from "@/components/useMe";
import StockCreateRecovery, { useStockCreateRecovery } from "@/components/StockCreateRecovery";
import SkuHoverCard from "@/components/SkuHoverCard";
import ListToolbar from "@/components/ListToolbar";
import { useListState } from "@/components/useListState";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { TRANSFER_TYPES, TRANSFER_TYPE_LABELS, type TransferType } from "@/lib/transfer-types";
import { groupTransferDraftLanes, transferDraftPayload } from "@/lib/transfer-draft";

interface TransferSuggestRow {
  skuId: number;
  code: string;
  name: string;
  baseUom: string;
  fromWarehouse: string;
  fromWarehouseId: number;
  toWarehouse: string;
  toWarehouseId: number;
  qty: number;
  fromCoverBefore: number | null;
  toCoverBefore: number;
  toCoverAfter: number;
  reason: string;
  /** D57：该 SKU 预警阈值与取值来源（任一段落到全局缺省 → 行上标「按默认周期」） */
  alertDays: number;
  basis: { part: string; value: number; source: string; field: string | null }[];
  usedDefault: boolean;
  /** W4 效期：本次调拨按 FEFO 会动到的最近到期批次剩余天数；无效期数据 = null */
  minDaysLeft: number | null;
  /** 调出仓压着临期批次——挪走即避免报废 */
  expiryDriven: boolean;
  /** 调出仓已过期数量（已从可调拨量中扣除） */
  expiredHeld: number;
  fefoLots: { batchNo: string | null; expiryDate: string | null; qty: string }[];
}

/** TR-11 线路汇总：零散建议按 (调出仓, 调入仓) 分组，看「这条线路总共要走多少」；只读，不合并成单 */
interface TransferSuggestLane {
  fromWarehouseId: number;
  toWarehouseId: number;
  fromWarehouse: string;
  toWarehouse: string;
  lineCount: number;
  skuCount: number;
  totalQty: number;
}

interface TransferSuggestData {
  rows: TransferSuggestRow[];
  total: number;
  /** 全部（未分页）建议的线路汇总——服务端早已下发，此前界面从不消费 */
  lanes: TransferSuggestLane[];
  summary: {
    skuCount: number;
    lineCount: number;
    totalQty: number;
    horizonDays: number;
    excludedSnapshotWarehouses: string[];
    expiryDrivenCount: number;
    expiredHeldTotal: number;
    expiryToday: string;
  };
}

const nz = (v: number): string => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });

export default function TransferSuggestClient() {
  const me = useMe();
  return <TransferSuggestWorkspace key={`${me?.id}:${me?.roles.join(",")}`} me={me} />;
}

function TransferSuggestWorkspace({ me }: { me: Me | null }) {
  const { message } = App.useApp();
  const [data, setData] = useState<TransferSuggestData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  // skuIds：预警行深链 `?skuIds=1,2`（D57 IAL-04）——API 早已支持，此前页面不读、落到全量列表（审计 #2）
  const listState = useListState({ key: "transfer-suggest", defaults: { q: "", skuIds: "" }, defaultPageSize: 50 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const skuIds = (filters.skuIds ?? "").trim();

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setLoadError(null);
    setData(null);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (skuIds) params.set("skuIds", skuIds);
      const next = await fetchJson<TransferSuggestData>(`/api/report/transfer-suggest?${params.toString()}`, { signal: controller.signal });
      if (!controller.signal.aborted) setData(next);
    } catch (e) {
      if (!controller.signal.aborted) setLoadError((e as Error).message);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [q, skuIds, page, pageSize]);
  const recovery = useStockCreateRecovery(me?.id ?? null, hasAnyRole(me, "warehouse"), () => void load());
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => requestRef.current?.abort(), []);

  /* ── 交接：选中的建议 → DB 调拨单**草稿**（只建草稿，提交/审批/过账一律走原流程） ── */
  const [selected, setSelected] = useState<TransferSuggestRow[]>([]);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftLaneKey, setDraftLaneKey] = useState<string | null>(null);
  const [draftType, setDraftType] = useState<TransferType>("inter_warehouse");
  const [draftReason, setDraftReason] = useState("");
  const [draftRemark, setDraftRemark] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftedDocNo, setDraftedDocNo] = useState<string | null>(null);

  // 一张 DB 单只能有一个 (源仓, 转入仓)：跨线路的选择必须逐线路建单，绝不合并
  const draftLanes = useMemo(() => groupTransferDraftLanes(selected), [selected]);
  const activeLane = draftLanes.find((l) => l.key === draftLaneKey) ?? draftLanes[0] ?? null;

  // 数据刷新后同步勾选：仍在结果里的行取最新建议量，消失的行剔除
  useEffect(() => {
    if (!data) return;
    const byKey = new Map(data.rows.map((r) => [`${r.skuId}-${r.fromWarehouseId}-${r.toWarehouseId}`, r]));
    setSelected((prev) => prev.flatMap((r) => {
      const k = `${r.skuId}-${r.fromWarehouseId}-${r.toWarehouseId}`;
      return byKey.has(k) ? [byKey.get(k)!] : [r];
    }));
  }, [data]);

  const openDraft = () => {
    if (!hasAnyRole(me, "warehouse") || !recovery.ready || recovery.busy || recovery.request) {
      message.info("创建库存单需仓管权限；如有待核对请求，请先找回原单"); return;
    }
    if (selected.length === 0) return;
    setDraftLaneKey(draftLanes[0]?.key ?? null);
    setDraftedDocNo(null);
    setDraftOpen(true);
  };

  const submitDraft = async () => {
    if (!activeLane) return;
    setDrafting(true);
    try {
      const res = (await recovery.submit(transferDraftPayload(activeLane, { transferType: draftType, reason: draftReason, remark: draftRemark })))?.document;
      if (!res) return;
      setDraftedDocNo(res.docNo);
      setSelected((prev) => prev.filter((r) => `${r.fromWarehouseId}>${r.toWarehouseId}` !== activeLane.key));
      message.success(`已确认原库存单：${res.docNo}，请核对当前状态`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  const columns: ColumnsType<TransferSuggestRow> = [
    {
      title: "SKU 编码",
      dataIndex: "code",
      width: 155,
      fixed: "left",
      render: (v: string) => <SkuHoverCard code={v} />,
    },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    { title: "调出仓", dataIndex: "fromWarehouse", width: 130 },
    { title: "调入仓", dataIndex: "toWarehouse", width: 130 },
    {
      title: "建议调拨量",
      dataIndex: "qty",
      width: 130,
      align: "right",
      render: (v: number, r) => (
        <Tag color="orange" style={{ marginInlineEnd: 0, fontWeight: 600 }}>{nz(v)} {r.baseUom}</Tag>
      ),
    },
    {
      title: "调出仓可销(前)",
      dataIndex: "fromCoverBefore",
      width: 125,
      align: "right",
      render: (v: number | null) =>
        v == null ? <Typography.Text type="secondary">无出库·呆滞</Typography.Text> : `${nz(v)} 天`,
    },
    {
      title: "调入仓可销(前→后)",
      dataIndex: "toCoverBefore",
      width: 155,
      align: "right",
      render: (v: number, r) => (
        <span>
          <Typography.Text type="danger" strong>{nz(v)}</Typography.Text>
          {" → "}
          <Typography.Text type="success" strong>{nz(r.toCoverAfter)}</Typography.Text>
          {" 天"}
        </span>
      ),
    },
    {
      title: "预警阈值",
      dataIndex: "alertDays",
      width: 120,
      align: "right",
      render: (v: number, r) => (
        <Tooltip title={r.basis.map((b) => `${b.part === "production" ? "加工" : b.part === "logistics" ? "在途" : "缓冲"} ${b.value} 天（${b.source === "sku_params" ? `SKU 参数 ${b.field ?? ""}` : b.source === "default" ? "全局缺省" : "参数"}）`).join("；")}>
          <span>
            {v} 天
            {r.usedDefault ? <Tag style={{ marginInlineStart: 4 }}>按默认周期</Tag> : null}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "效期",
      dataIndex: "minDaysLeft",
      width: 130,
      align: "right",
      render: (v: number | null, r) => {
        const lots = r.fefoLots.length
          ? `按先到期先出会动到：${r.fefoLots.slice(0, 3).map((l) => `${l.expiryDate ?? "无效期"}${l.batchNo ? `（${l.batchNo}）` : ""} ${Number(l.qty).toLocaleString("zh-CN")}`).join("；")}${r.fefoLots.length > 3 ? " …" : ""}`
          : "调出仓无批次效期数据（批次参考层未覆盖该仓该 SKU）";
        const expired = r.expiredHeld > 0 ? `\n调出仓另有 ${nz(r.expiredHeld)} 已过期，已从可调拨量中扣除——过期货绝不建议调拨` : "";
        return (
          <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{`${lots}${expired}`}</span>}>
            <Space size={4}>
              {v == null ? <Typography.Text type="secondary">—</Typography.Text> : <span>{v} 天</span>}
              {r.expiryDriven ? <Tag color="volcano" style={{ marginInlineEnd: 0 }}>临期先挪</Tag> : null}
              {r.expiredHeld > 0 ? <Tag style={{ marginInlineEnd: 0 }}>过期 {nz(r.expiredHeld)}</Tag> : null}
            </Space>
          </Tooltip>
        );
      },
    },
    {
      title: "理由",
      dataIndex: "reason",
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <span>{v}</span>
        </Tooltip>
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>调拨建议（先挪后买）</Typography.Title>
      {!draftOpen && <StockCreateRecovery recovery={recovery} />}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="全网总量看着没问题时，货可能压在一个仓、另一个仓已断货。本页把视角下沉到逐仓：先挪自己的货，再花钱买新的。"
        description={
          data ? (
            <Typography.Text type="secondary">
              <b>逐仓需求为代理口径</b>：系统暂无逐仓需求信号（销量只到渠道维度，渠道↔仓库映射尚未建立），
              故以近 {data.summary.horizonDays} 天该仓的<b>出库流水</b>代理其真实需求（含调拨出库/盘亏等非纯销售出库，属发货强度而非销量）；
              映射建立后可更精确。
              盈余仓 = 可销天数超目标覆盖 2 倍，或无出库但有库存；缺口仓 = 可销天数低于告警线且有出库历史；调拨量已为调出仓保留告警线天数的自留缓冲。
              <br />
              <b>仅记账仓</b>参与建议：快照仓（保税/E/云）无实时账、无库存流水，既算不出该仓日均也无法承接实物调拨
              {data.summary.excludedSnapshotWarehouses.length > 0
                ? `（已排除：${data.summary.excludedSnapshotWarehouses.join("、")}）`
                : ""}
              ；委外仓（加工厂垫料）与在途虚拟仓非自有可调配库位，一并排除。
              <br />
              <b>效期意识</b>：盈余仓按<b>最近效期优先</b>让出（先挪先卖，把调拨变成避免报废的手段），
              每条建议给出按先到期先出实际会动到的批次；<b>已过期数量绝不参与调拨</b>，已从可调拨在库中扣除并在行上单列
              （效期判定基准日 {data.summary.expiryToday}；批次效期取自盘点参考层，与账面在库可能不同源，故只用于排序与解释）。
              <br />
              <b>只读建议，不自动开单</b>：勾选建议行后可「生成调拨草稿」——只落 DB 调拨单**草稿**（一条线路一张），
              提交/审批/过账仍走原流程与原权限，本页永不过账。
            </Typography.Text>
          ) : null
        }
      />
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="调拨建议" retrying={loading} />
      <Space className="compact-stat-strip" wrap>
        <Statistic title="涉及 SKU 数" value={data ? data.summary.skuCount : "—"} />
        <Statistic title="建议条数" value={data ? data.summary.lineCount : "—"} />
        <Statistic title="建议总量（基础单位）" value={data ? data.summary.totalQty : "—"} />
        <Statistic title="临期驱动条数" value={data ? data.summary.expiryDrivenCount : "—"} />
        <Statistic title="已过期（不可调拨）" value={data ? data.summary.expiredHeldTotal : "—"} />
      </Space>
      {/* TR-11 线路汇总：服务端按 (调出仓, 调入仓) 分组的只读视角——一条线路一次车，
          让「12 条零散建议」变成「3 条线路」。不合并成单：建单仍逐线路人工确认。 */}
      {data && data.lanes.length > 0 ? (
        <Table<TransferSuggestLane>
          rowKey={(l) => `${l.fromWarehouseId}>${l.toWarehouseId}`}
          size="small"
          style={{ marginBottom: 12 }}
          pagination={false}
          scroll={{ x: "max-content", y: 220 }}
          title={() => (
            <Space size={8}>
              <Typography.Text strong>线路汇总</Typography.Text>
              <Typography.Text type="secondary">
                共 {data.lanes.length} 条线路（覆盖全部 {data.summary.lineCount} 条建议，不受分页影响）；一条线路一次车，只读视角，不合并成单
              </Typography.Text>
            </Space>
          )}
          dataSource={data.lanes}
          columns={[
            { title: "调出仓", dataIndex: "fromWarehouse", width: 150 },
            { title: "调入仓", dataIndex: "toWarehouse", width: 150 },
            { title: "建议条数", dataIndex: "lineCount", width: 100, align: "right" },
            { title: "涉及 SKU", dataIndex: "skuCount", width: 100, align: "right" },
            { title: "合计量（基础单位）", dataIndex: "totalQty", width: 160, align: "right", render: (v: number) => nz(v) },
          ]}
        />
      ) : null}
      <ListToolbar
        state={listState}
        extra={
          <Space wrap>
            <Button type="primary" disabled={selected.length === 0} onClick={openDraft}>
              生成调拨草稿{selected.length > 0 ? `（已选 ${selected.length} 条 / ${draftLanes.length} 条线路）` : ""}
            </Button>
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索 SKU 编码/名称"
              style={{ width: 260 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
            {skuIds ? (
              <Tag closable onClose={() => listState.setFilter({ skuIds: "" })} color="processing">
                仅预警行 SKU（{skuIds.split(",").filter(Boolean).length} 个）
              </Tag>
            ) : null}
          </Space>
        }
      />
      <Table<TransferSuggestRow>
        rowKey={(r) => `${r.skuId}-${r.fromWarehouseId}-${r.toWarehouseId}`}
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        locale={{ emptyText: loadError ? "数据未加载" : "当前条件下无调拨建议" }}
        scroll={{ x: "max-content" }}
        rowSelection={{
          preserveSelectedRowKeys: true,
          selectedRowKeys: selected.map((r) => `${r.skuId}-${r.fromWarehouseId}-${r.toWarehouseId}`),
          // preserveSelectedRowKeys 下，跨页保留的 key 在缓存缺失时会给出 undefined —— 过滤掉，别让它进载荷
          onChange: (_keys, rows) => setSelected(rows.filter(Boolean)),
        }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
      />
      <Modal
        open={draftOpen}
        title="生成调拨草稿"
        okText={draftedDocNo ? "关闭" : "生成草稿"}
        cancelButtonProps={{ style: draftedDocNo ? { display: "none" } : undefined }}
        confirmLoading={drafting || recovery.busy}
        onCancel={() => setDraftOpen(false)}
        onOk={draftedDocNo ? () => setDraftOpen(false) : () => void submitDraft()}
        okButtonProps={{ disabled: !draftedDocNo && (activeLane == null || drafting || recovery.busy || !recovery.ready || !!recovery.request) }}
        width={720}
      >
        <StockCreateRecovery recovery={recovery} />
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="只生成草稿，不提交、不审批、不过账"
          description={
            <Typography.Text type="secondary">
              草稿落在「库存单据」列表（DB 调拨单），提交/审批/过账仍走原流程与原权限；
              一张 DB 单只能有一个（调出仓 → 调入仓），因此**逐线路建单**，跨线路的选择请分次生成。
              建议量按建议原值带入；创建失败可到库存单据修正原请求，已建单请核对原单再提交。
            </Typography.Text>
          }
        />
        {draftedDocNo ? (
          <Alert type="success" showIcon message={`已确认原单：${draftedDocNo}`} description="请打开原库存单核对当前状态；只有草稿才可继续提交审批。" />
        ) : activeLane == null ? (
          <Alert type="warning" showIcon message="所选建议没有可成单的数量" />
        ) : (
          <>
            <Space wrap style={{ marginBottom: 12 }}>
              <Select
                style={{ width: 320 }}
                value={activeLane.key}
                onChange={(v) => setDraftLaneKey(v)}
                options={draftLanes.map((l) => ({
                  value: l.key,
                  label: `${l.fromWarehouse} → ${l.toWarehouse}（${l.lines.length} 个 SKU / ${nz(l.totalQty)}）`,
                }))}
              />
              <Select<TransferType>
                style={{ width: 180 }}
                value={draftType}
                onChange={setDraftType}
                options={TRANSFER_TYPES.map((t) => ({ value: t, label: TRANSFER_TYPE_LABELS[t] }))}
              />
              <Input
                style={{ width: 180 }}
                maxLength={50}
                placeholder="业务原因（可选，如「借调」）"
                value={draftReason}
                onChange={(e) => setDraftReason(e.target.value)}
              />
            </Space>
            <Table<{ skuId: number; code: string; name: string; baseUom: string; qty: string }>
              rowKey="skuId"
              size="small"
              pagination={false}
              scroll={{ y: 260 }}
              dataSource={activeLane.lines}
              columns={[
                { title: "SKU 编码", dataIndex: "code", width: 130 },
                { title: "名称", dataIndex: "name", ellipsis: true },
                { title: "数量", dataIndex: "qty", width: 130, align: "right", render: (v: string, r) => `${nz(Number(v))} ${r.baseUom}` },
              ]}
              style={{ marginBottom: 12 }}
            />
            <Input.TextArea
              rows={2}
              maxLength={150}
              placeholder="备注（可选；系统会自动注明来源为调拨建议页）"
              value={draftRemark}
              onChange={(e) => setDraftRemark(e.target.value)}
            />
          </>
        )}
      </Modal>
    </div>
  );
}
