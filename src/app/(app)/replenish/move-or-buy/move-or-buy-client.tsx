"use client";

/**
 * 「先挪后买」统一决策表（只读页 + 两个既有草稿动作）。
 *
 * 为什么有这一页：计划员每个 SKU 只有**一个**问题——在必须下单之前，能不能先从别的仓挪过来？
 * 系统此前把它拆成两页（`/report/transfer-suggest` 能挪多少、`/replenish` 该买多少），
 * 而两页的「可销天数」口径不同且不可比，于是没人敢把两个数放在一起看。
 *
 * 本页的纪律：
 *  - **两套可销天数各自带名字并排显示**（全网可销天数 / 调入仓可销天数），页面明说不可比，
 *    绝不静默换算、相减或互相校准。唯一被合并计算的是件数——件数是可比的；
 *  - 排序 = **最晚下单日升序**（空值置底），因为这页回答"今天必须动哪几个"；
 *  - 两个动作都复用既有草稿端点，**不新增任何写入面**：
 *    调拨 → POST /api/inventory/stock-doc（载荷装配 lib/transfer-draft，与调拨建议页同一函数）；
 *    采购 → POST /api/replenish/draft（BH 备货申请草稿，人工闸在服务端）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, App, Button, Input, Modal, Select, Space, Statistic, Table, Tag, Tooltip, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";
import CaliberNote from "@/components/CaliberNote";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import SearchInput from "@/components/SearchInput";
import SkuHoverCard from "@/components/SkuHoverCard";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatCount, formatYuan } from "@/components/format";
import { useListState } from "@/components/useListState";
import { groupTransferDraftLanes, transferDraftPayload } from "@/lib/transfer-draft";
import { TRANSFER_TYPES, TRANSFER_TYPE_LABELS, type TransferType } from "@/lib/transfer-types";

interface TransferOption {
  fromWarehouseId: number;
  fromWarehouse: string;
  toWarehouseId: number;
  toWarehouse: string;
  qty: number;
  fromCoverBefore: number | null;
  toCoverBefore: number;
  toCoverAfter: number;
  reason: string;
  expiryDriven: boolean;
  minDaysLeft: number | null;
  laneMedianUnitFee: string | null;
  laneEstCost: string | null;
  laneSamples: number;
}

interface Row {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  baseUom: string;
  onHand: number;
  daily: number;
  daysCover: number | null;
  leadDays: number | null;
  orderByDate: string | null;
  daysToShortage: number | null;
  orderWindowMissed: boolean;
  suggestQty: string | null;
  transfers: TransferOption[];
  transferQty: number;
  residualBuyQty: string | null;
  action: "transfer_only" | "transfer_then_buy" | "buy_only" | "buy_suppressed" | "none";
  /** C9：采购建议被「已复核并放弃」的抑制窗口扣着——不是「不用买」 */
  suppression: {
    id: number; reasonLabel: string; reason: string; by: string;
    since: string; untilDate: string; daysLeft: number; withheldQty: string | null; label: string;
  } | null;
  withheldBuyQty: string | null;
  /** C10：另一页已经为这个 SKU 起草的量（只提示，不参与净额） */
  inFlightDrafts: { buyQty: number; buyDocs: number; transferQty: number; transferDocs: number };
  inFlightWarning: string | null;
}

interface Data {
  rows: Row[];
  total: number;
  summary: {
    skuCount: number;
    coveredByTransfer: number;
    stillNeedBuy: number;
    buyOnly: number;
    declineSuppressed: number;
    noAction: number;
    horizonDays: number;
    transferLineTotal: number;
    transferLinesLoaded: number;
    transferTruncated: boolean;
    calibreKey: string;
    moneyVisible: boolean;
    laneCostAvailable: boolean;
    calibres: {
      replenish: { label: string; basis: string };
      transfer: { label: string; basis: string };
      incomparable: string;
    };
  };
}

type Filters = { q?: string };

const ACTION_TAG: Record<Row["action"], { color: string; label: string }> = {
  transfer_only: { color: "green", label: "先挪即可" },
  transfer_then_buy: { color: "orange", label: "先挪再买" },
  buy_only: { color: "red", label: "只能买" },
  buy_suppressed: { color: "volcano", label: "采购被抑制" },
  none: { color: "default", label: "无需动作" },
};

const dash = <Typography.Text type="secondary">—</Typography.Text>;

export default function MoveOrBuyClient() {
  const { message } = App.useApp();
  const listState = useListState<Filters>({ key: "move-or-buy", defaults: { q: "" }, defaultPageSize: 50 });
  const query = listState.queryString();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchJson<Data>(`/api/replenish/move-or-buy?${query}`, { signal: controller.signal });
      if (!controller.signal.aborted) setData(next);
    } catch (e) {
      if (!controller.signal.aborted) setLoadError((e as Error).message);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [query]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => requestRef.current?.abort(), []);

  /* ── 动作 1：先挪（既有 DB 调拨草稿端点） ── */
  const [moving, setMoving] = useState<Row | null>(null);
  const [laneKey, setLaneKey] = useState<string | null>(null);
  const [transferType, setTransferType] = useState<TransferType>("inter_warehouse");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [movedDocNo, setMovedDocNo] = useState<string | null>(null);

  const moveLanes = useMemo(
    () => (moving ? groupTransferDraftLanes(moving.transfers.map((t) => ({
      skuId: moving.skuId,
      code: moving.code,
      name: moving.name,
      baseUom: moving.baseUom,
      fromWarehouseId: t.fromWarehouseId,
      fromWarehouse: t.fromWarehouse,
      toWarehouseId: t.toWarehouseId,
      toWarehouse: t.toWarehouse,
      qty: t.qty,
    }))) : []),
    [moving],
  );
  const activeLane = moveLanes.find((l) => l.key === laneKey) ?? moveLanes[0] ?? null;

  const openMove = (row: Row) => {
    setMoving(row);
    setLaneKey(null);
    setMovedDocNo(null);
    setReason("");
  };

  const submitMove = async () => {
    if (!activeLane) return;
    setSubmitting(true);
    try {
      const res = await postJson<{ docNo: string }>(
        "/api/inventory/stock-doc",
        transferDraftPayload(activeLane, { transferType, reason }),
      );
      setMovedDocNo(res.docNo);
      message.success(`调拨草稿已生成：${res.docNo}（草稿态，请到「库存单据」提交审批）`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  /* ── 动作 2：再买（既有 BH 备货草稿端点，带入"挪完仍差"的残量） ── */
  const [buying, setBuying] = useState<Row | null>(null);
  const [buyRemark, setBuyRemark] = useState("");
  const [boughtDocNo, setBoughtDocNo] = useState<string | null>(null);

  const openBuy = (row: Row) => {
    setBuying(row);
    setBoughtDocNo(null);
    setBuyRemark("");
  };

  const submitBuy = async () => {
    if (!buying?.residualBuyQty) return;
    setSubmitting(true);
    try {
      const res = await postJson<{ docNo: string }>("/api/replenish/draft", {
        remark: buyRemark.trim() || "由「先挪后买」决策表生成（已扣除可调拨量）",
        items: [{ skuId: buying.skuId, qty: buying.residualBuyQty }],
      });
      setBoughtDocNo(res.docNo);
      message.success(`备货申请草稿已生成：${res.docNo}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const moneyVisible = data?.summary.moneyVisible ?? false;

  const columns: ColumnsType<Row> = [
    { title: "SKU 编码", dataIndex: "code", width: 150, fixed: "left", render: (v: string) => <SkuHoverCard code={v} /> },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 200 },
    {
      title: "结论",
      dataIndex: "action",
      width: 135,
      /* C10：另一页已经为同一个缺口起草过的量必须**在结论旁边**显示。
         本页起草的是净额后的采购量、/replenish 起草的是全额，两页各下一次就多订一个调拨量。 */
      render: (v: Row["action"], r) => (
        <Space size={2} direction="vertical" style={{ lineHeight: 1.4 }}>
          <Tag color={ACTION_TAG[v].color} style={{ marginInlineEnd: 0 }}>{ACTION_TAG[v].label}</Tag>
          {r.inFlightWarning ? (
            <Tooltip title={r.inFlightWarning}>
              <Tag color="gold" style={{ marginInlineEnd: 0 }}>另一页已起草</Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: "最晚下单日",
      dataIndex: "orderByDate",
      width: 135,
      render: (v: string | null, r) =>
        v == null ? dash : (
          <Space size={4}>
            <Typography.Text strong={r.orderWindowMissed} type={r.orderWindowMissed ? "danger" : undefined}>{v}</Typography.Text>
            {r.orderWindowMissed ? <Tag color="red">已错过</Tag> : null}
          </Space>
        ),
    },
    {
      // 口径 1（销售）：列名必须写死"全网"，不能只写"可销天数"
      title: <Tooltip title={data?.summary.calibres.replenish.basis}><span>全网可销天数</span></Tooltip>,
      dataIndex: "daysCover",
      width: 130,
      align: "right",
      render: (v: number | null, r) => (v == null ? dash : (
        <Space size={4}>
          <span>{v} 天</span>
          {r.leadDays != null ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>/ 周期 {r.leadDays}</Typography.Text> : null}
        </Space>
      )),
    },
    {
      title: "可挪合计",
      dataIndex: "transferQty",
      width: 120,
      align: "right",
      render: (v: number, r) => (v > 0 ? <Tag color="green" style={{ marginInlineEnd: 0 }}>{formatCount(v)} {r.baseUom}</Tag> : dash),
    },
    {
      title: "建议补货量",
      dataIndex: "suggestQty",
      width: 145,
      align: "right",
      /* C9 抑制绝不静默：被扣下的采购量必须**在这一格里**说出来，
         否则读者只看到一个「—」，分不清「不用买」与「系统扣着一笔没让你看」。 */
      render: (v: string | null, r) =>
        v != null
          ? `${formatCount(Number(v))} ${r.baseUom}`
          : r.suppression
            ? (
              <Tooltip title={r.suppression.label}>
                <Tag color="volcano" style={{ marginInlineEnd: 0 }}>
                  已抑制 · 扣下 {r.withheldBuyQty ? formatCount(Number(r.withheldBuyQty)) : "—"} {r.baseUom}
                </Tag>
              </Tooltip>
            )
            : dash,
    },
    {
      title: "挪完仍需买",
      dataIndex: "residualBuyQty",
      width: 130,
      align: "right",
      render: (v: string | null, r) =>
        v == null ? dash
          : Number(v) <= 0
            ? <Tag color="green" style={{ marginInlineEnd: 0 }}>0（先挪即可）</Tag>
            : <Typography.Text strong type="warning">{formatCount(Number(v))} {r.baseUom}</Typography.Text>,
    },
    {
      title: "动作",
      key: "_actions",
      width: 190,
      fixed: "right",
      render: (_, r) => (
        <Space size={4}>
          <Button type="link" size="small" disabled={r.transfers.length === 0} onClick={() => openMove(r)}>
            建调拨草稿
          </Button>
          <Button
            type="link"
            size="small"
            disabled={r.residualBuyQty == null || Number(r.residualBuyQty) <= 0}
            onClick={() => openBuy(r)}
          >
            建备货草稿
          </Button>
        </Space>
      ),
    },
  ];

  const transferColumns: ColumnsType<TransferOption> = [
    { title: "调出仓", dataIndex: "fromWarehouse", width: 140 },
    { title: "调入仓", dataIndex: "toWarehouse", width: 140 },
    {
      title: "可调拨量",
      dataIndex: "qty",
      width: 120,
      align: "right",
      render: (v: number) => formatCount(v),
    },
    {
      title: "调出仓可销（逐仓口径）",
      dataIndex: "fromCoverBefore",
      width: 175,
      align: "right",
      render: (v: number | null) => (v == null ? <Typography.Text type="secondary">无出库·呆滞</Typography.Text> : `${v} 天`),
    },
    {
      // 口径 2（逐仓发货流水）：与主表的"全网可销天数"分母不同源，列名与 Tooltip 都写明
      title: <Tooltip title={data?.summary.calibres.transfer.basis}><span>调入仓可销（前→后）</span></Tooltip>,
      dataIndex: "toCoverBefore",
      width: 175,
      align: "right",
      render: (v: number, r) => (
        <span>
          <Typography.Text type="danger" strong>{v}</Typography.Text>
          {" → "}
          <Typography.Text type="success" strong>{r.toCoverAfter}</Typography.Text>
          {" 天"}
        </span>
      ),
    },
    {
      title: moneyVisible ? "线路费用（估算）" : "线路费用",
      dataIndex: "laneEstCost",
      width: 190,
      align: "right",
      render: (v: string | null, r) => {
        if (!moneyVisible) return <Typography.Text type="secondary">无金额权限</Typography.Text>;
        if (v == null) {
          return (
            <Tooltip title={r.laneSamples > 0 ? "该线路有完成单但未登记过费用——未登记不等于免费" : "该线路无历史费用样本"}>
              <Typography.Text type="secondary">无费用样本</Typography.Text>
            </Tooltip>
          );
        }
        return (
          <Tooltip title={`按线路单位费用中位数 ${r.laneMedianUnitFee} 元/件 × ${formatCount(r.qty)} 件估算（样本 ${r.laneSamples} 单）`}>
            <span>{formatYuan(Number(v))}</span>
          </Tooltip>
        );
      },
    },
    {
      title: "效期 / 理由",
      dataIndex: "reason",
      ellipsis: true,
      render: (v: string, r) => (
        <Space size={4} wrap>
          {r.expiryDriven ? <Tag color="volcano">临期先挪</Tag> : null}
          {r.minDaysLeft != null ? <Tag>最近到期 {r.minDaysLeft} 天</Tag> : null}
          <Typography.Text type="secondary">{v}</Typography.Text>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>先挪后买 · 统一决策表</Typography.Title>
      <CaliberNote
        summary="每个 SKU 一行，按最晚下单日排序：先看能从哪个仓挪多少，再看挪完还差多少必须买。"
        detail={
          <div>
            <p><b>两列可销天数不是同一个口径，不能比较。</b></p>
            <p>
              · <b>{data?.summary.calibres.replenish.label ?? "全网可销天数"}</b>：
              {data?.summary.calibres.replenish.basis ?? "全网在库 ÷ 近 3 月日均销（销售口径）"}
            </p>
            <p>
              · <b>{data?.summary.calibres.transfer.label ?? "调入仓可销天数"}</b>：
              {data?.summary.calibres.transfer.basis ?? "该仓在库 ÷ 该仓近 N 天出库流水日均（逐仓发货强度代理）"}
            </p>
            <p>{data?.summary.calibres.incomparable ?? ""}</p>
            <p>
              本页唯一做加减的量是<b>件数</b>：「挪完仍需买」= 建议补货量 − 可挪合计（不为负）。
              两个动作都只生成<b>草稿</b>，提交/审批/过账仍走原流程与原权限。
            </p>
            <p>
              装配口径 {data?.summary.calibreKey ?? "—"}；调拨侧读入{" "}
              {data ? `${data.summary.transferLinesLoaded}/${data.summary.transferLineTotal}` : "—"} 条建议
              {data?.summary.transferTruncated ? "（未取全，见上方红条）" : ""}。
            </p>
          </div>
        }
      />
      {data && !data.summary.laneCostAvailable ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="线路费用读模型不可用——费用列为空，挪货与采购的结论不受影响"
        />
      ) : null}
      {/* 调拨侧被截断时结论会**反向出错**（有货可挪的行会显示「只能买」），必须显式告警而不是静默 */}
      {data?.summary.transferTruncated ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`调拨建议未取全：服务端 ${data.summary.transferLineTotal} 条，本页只读入 ${data.summary.transferLinesLoaded} 条`}
          description="未读入的调拨建议在本页会表现为「只能买」——请先缩小范围或到调拨建议页核对，再据此下单。"
        />
      ) : null}
      <LoadErrorAlert error={loadError} onRetry={() => void load()} subject="先挪后买决策表" retrying={loading} />
      <Space size={24} wrap style={{ marginBottom: 12 }}>
        <Statistic title="需要动作的 SKU" value={data ? data.summary.skuCount : "—"} />
        <Statistic title="先挪即可（无需采购）" value={data ? data.summary.coveredByTransfer : "—"} />
        <Statistic title="先挪再买" value={data ? data.summary.stillNeedBuy : "—"} />
        <Statistic title="只能买（无货可挪）" value={data ? data.summary.buyOnly : "—"} />
        <Statistic title="采购被抑制（已复核并放弃）" value={data ? data.summary.declineSuppressed : "—"} />
        <Statistic title="无需动作" value={data ? data.summary.noAction : "—"} />
      </Space>
      <ListToolbar
        state={listState}
        extra={
          <SearchInput
            key={listState.filters.q}
            allowClear
            defaultValue={listState.filters.q}
            placeholder="搜索 SKU 编码/名称"
            style={{ width: 260 }}
            onSearch={(v) => listState.setFilter({ q: v.trim() })}
          />
        }
        primaryActions={
          <Space size={12}>
            <Link href="/report/transfer-suggest">调拨建议原表 →</Link>
            <Link href="/replenish">补货建议原表 →</Link>
          </Space>
        }
      />
      <Table<Row>
        rowKey="skuId"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        locale={{ emptyText: loadError ? "数据未加载" : "当前没有需要动作的 SKU（既无补货建议，也无可挪库存）" }}
        scroll={{ x: "max-content" }}
        expandable={{
          rowExpandable: (r) => r.transfers.length > 0,
          expandedRowRender: (r) => (
            <Table<TransferOption>
              rowKey={(t) => `${t.fromWarehouseId}-${t.toWarehouseId}`}
              size="small"
              pagination={false}
              columns={transferColumns}
              dataSource={r.transfers}
              scroll={{ x: "max-content" }}
            />
          ),
        }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
      />

      {/* 动作 1：调拨草稿（复用 /api/inventory/stock-doc） */}
      <Modal
        open={moving != null}
        title={moving ? `建调拨草稿：${moving.code}` : "建调拨草稿"}
        okText={movedDocNo ? "关闭" : "生成草稿"}
        cancelButtonProps={{ style: movedDocNo ? { display: "none" } : undefined }}
        confirmLoading={submitting}
        onCancel={() => setMoving(null)}
        onOk={movedDocNo ? () => setMoving(null) : () => void submitMove()}
        okButtonProps={{ disabled: !movedDocNo && (activeLane == null || submitting) }}
        width={640}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="只生成草稿，不提交、不审批、不过账"
          description="一张 DB 单只能有一个（调出仓 → 调入仓）；有多条线路请分次生成。"
        />
        {movedDocNo ? (
          <Alert type="success" showIcon message={`草稿已生成：${movedDocNo}`} description="请到「库存 → 库存单据」核对后提交审批。" />
        ) : activeLane == null ? (
          <Alert type="warning" showIcon message="该 SKU 没有可成单的调拨量" />
        ) : (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Select
              style={{ width: "100%" }}
              value={activeLane.key}
              onChange={(v) => setLaneKey(v)}
              options={moveLanes.map((l) => ({
                value: l.key,
                label: `${l.fromWarehouse} → ${l.toWarehouse}（${formatCount(l.totalQty)}）`,
              }))}
            />
            <Select<TransferType>
              style={{ width: "100%" }}
              value={transferType}
              onChange={setTransferType}
              options={TRANSFER_TYPES.map((t) => ({ value: t, label: TRANSFER_TYPE_LABELS[t] }))}
            />
            <Input
              maxLength={50}
              placeholder="业务原因（可选）"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Space>
        )}
      </Modal>

      {/* 动作 2：BH 备货草稿（复用 /api/replenish/draft，量 = 挪完仍需买） */}
      <Modal
        open={buying != null}
        title={buying ? `建备货草稿：${buying.code}` : "建备货草稿"}
        okText={boughtDocNo ? "关闭" : "生成草稿"}
        cancelButtonProps={{ style: boughtDocNo ? { display: "none" } : undefined }}
        confirmLoading={submitting}
        onCancel={() => setBuying(null)}
        onOk={boughtDocNo ? () => setBuying(null) : () => void submitBuy()}
        width={560}
      >
        {boughtDocNo ? (
          <Alert type="success" showIcon message={`草稿已生成：${boughtDocNo}`} description="请到「委外生产 → 备货申请」核对后提交审批。" />
        ) : buying ? (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              message={`采购量已扣除可调拨量：建议 ${formatCount(Number(buying.suggestQty ?? 0))} − 可挪 ${formatCount(buying.transferQty)} = ${formatCount(Number(buying.residualBuyQty ?? 0))} ${buying.baseUom}`}
              description="只生成 BH 备货申请草稿，提交/审批仍走原流程；调拨草稿需另行生成，两者互不自动联动。"
            />
            <Input.TextArea
              rows={2}
              maxLength={500}
              placeholder="备注（可选）"
              value={buyRemark}
              onChange={(e) => setBuyRemark(e.target.value)}
            />
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
