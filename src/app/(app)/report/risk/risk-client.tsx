"use client";

import SearchInput from "@/components/SearchInput";

/** F 项：风险库存处置工作台——效期批次 × 货盘处置注记 × 销速 三源融合（只读，spec/13） */
import { useCallback, useEffect, useState } from "react";
import {  App, Button, Dropdown, Popconfirm, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson, postJson } from "@/components/fetchJson";
import { exportCsv } from "@/components/exportCsv";
import ListToolbar from "@/components/ListToolbar";
import { AsyncExportButton } from "@/components/ExportButton";
import { useListState } from "@/components/useListState";
import CaliberNote from "@/components/CaliberNote";
import { formatYuan } from "@/components/format";
import SkuHoverCard from "@/components/SkuHoverCard";

interface RiskRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  action: string;
  onHand: number;
  daily: number;
  cover: number | null;
  minDaysLeft: number | null;
  expiredQty: number;
  nearExpiryDays: number;
  nearQty: number;
  palletRemark: string | null;
  remarkMonth: string | null;
  disposalOpen: boolean;
  disposalId: number | null;
  externalNet30: string | null;
  externalLastSold: string | null;
  /** 非价格可见角色：服务端 maskSensitive 已删键 → undefined */
  amount?: string | null;
  atRiskAmount?: string | null;
}

interface MoneyCalibre {
  key: string;
  costSource: string;
  amountBasis: string;
  atRiskBasis: string;
  asOfNote: string;
  precisionNote: string;
  sortNote: string;
}

interface RiskData {
  today: string;
  slowThreshold: number;
  rows: RiskRow[];
  total: number;
  byAction: Record<string, number>;
  /** 服务端实际生效的排序键（金额序在服务端全集上排完再分页） */
  sort?: "action" | "atRiskAmount" | "amount";
  /** 金额口径（服务端唯一文案权威；无金额权限 = null） */
  moneyCalibre?: MoneyCalibre | null;
  costCoverage?: { covered: number; total: number } | null;
  canSeeValue?: boolean;
}

const ACTION_COLORS: Record<string, string> = {
  报废评审: "red",
  禁售隔离: "volcano",
  商务处置: "purple",
  促销清库: "orange",
  优先出库: "gold",
  滞销关注: "blue",
};
/** #15 处置决定→执行入口路由（不自动开审批单，仅引导到正确的执行页） */
function EXEC_ROUTE(r: RiskRow): { href: string; label: string } {
  const q = encodeURIComponent(r.code);
  switch (r.action) {
    case "报废评审":
      return r.disposalId
        ? {
            href: `/inventory/docs?create=scrap&skuId=${r.skuId}&disposalId=${r.disposalId}`,
            label: "创建已绑定的报废出库单；审批过账后自动完成处置",
          }
        : { href: `/inventory/expiry?q=${q}`, label: "先登记处置，再创建报废出库单" };
    case "禁售隔离": return { href: `/inventory/balance?q=${q}`, label: "库存定位·标记隔离" };
    case "商务处置":
    case "促销清库": return { href: `/report/demand?tab=pallet&q=${q}`, label: "货盘处置（促销/去化）" };
    case "优先出库": return { href: `/inventory/balance?q=${q}`, label: "库存定位·先进先出" };
    default: return { href: `/report/sku-360?sku=${q}`, label: "SKU 360 复盘" };
  }
}

const ACTION_ORDER = ["报废评审", "禁售隔离", "商务处置", "促销清库", "优先出库", "滞销关注"];

export default function RiskClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<RiskData | null>(null);
  const [loading, setLoading] = useState(false);
  // 列表页状态平台（E6-P1）：筛选/分页进 URL，密度与已保存视图存本地
  // sort 进 URL：金额排序必须由**服务端**在全集上做，客户端比较器只能排当前一页
  const listState = useListState({ key: "risk", defaults: { q: "", action: "", sort: "atRiskAmount" }, defaultPageSize: 50 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const action = filters.action;
  const sort = filters.sort || "atRiskAmount";
  const [selected, setSelected] = useState<RiskRow[]>([]);
  const [registering, setRegistering] = useState(false);

  const bulkRegister = async () => {
    const targets = selected.filter((r) => !r.disposalOpen);
    if (targets.length === 0) { message.info("所选行均已登记"); return; }
    setRegistering(true);
    try {
      const res = await postJson<{ registered: number; skipped: number }>("/api/report/risk", {
        items: targets.map((r) => ({ skuCode: r.code, action: r.action, note: r.palletRemark ?? undefined })),
      });
      message.success(`批量登记完成：新增 ${res.registered}，跳过 ${res.skipped}`);
      setSelected([]);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRegistering(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize), sort });
      if (action) params.set("action", action);
      setData(await fetchJson<RiskData>(`/api/report/risk?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, action, sort, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

  const doExport = async () => {
    const all: RiskRow[] = [];
    let serverTotal = 0;
    for (let p2 = 1; p2 <= 40; p2++) { // struct#17: 提高上限至 2 万行
      const params = new URLSearchParams({ q, page: String(p2), pageSize: "500", precise: "1", sort });
      if (action) params.set("action", action);
      const d = await fetchJson<RiskData>(`/api/report/risk?${params.toString()}`);
      serverTotal = d.total;
      all.push(...d.rows);
      if (all.length >= d.total) break;
    }
    const withValue = Boolean(data?.canSeeValue);
    exportCsv(`风险库存处置-${data?.today ?? ""}`,
      ["建议动作","SKU编码","名称","品牌","在库", ...(withValue ? ["在库金额","风险金额"] : []), "最短剩余效期(天)","临期阈值(天)","过期量","阈值内到期量","日均销","可销天数","货盘注记","已登记"],
      all.map((r) => [r.action, r.code, r.name, r.brand, r.onHand, ...(withValue ? [r.amount ?? "", r.atRiskAmount ?? ""] : []), r.minDaysLeft, r.nearExpiryDays, r.expiredQty, r.nearQty, r.daily, r.cover, r.palletRemark, r.disposalOpen ? "是" : ""]),
      all.length < serverTotal
        ? `……仅导出前 ${all.length} 行，服务端共 ${serverTotal} 行（浏览器分页取数已达上限）；请缩小筛选范围，或改用「导出任务」`
        : undefined,
    );
  };

  const columns: ColumnsType<RiskRow> = [
    {
      title: "建议动作",
      dataIndex: "action",
      width: 100,
      fixed: "left",
      render: (v: string) => <Tag color={ACTION_COLORS[v]}>{v}</Tag>,
    },
    {
      title: "SKU 编码", dataIndex: "code", width: 155,
      render: (v: string, r) => (
        <Space size={6}>
          <SkuHoverCard code={v} />
          {r.minDaysLeft != null ? <a href={`/inventory/expiry?q=${encodeURIComponent(v)}`} style={{ fontSize: 12 }}>批次</a> : null}
        </Space>
      ),
    },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    { title: "品牌", dataIndex: "brand", width: 100, render: (v: string | null) => v ?? "—" },
    { title: "在库", dataIndex: "onHand", width: 95, align: "right", render: (v: number) => v.toLocaleString("zh-CN") },
    // W2-5：处置排序需要「钱」——单位成本唯一权威 core/valuation，金额键按 PRICE_VISIBLE_ROLES 服务端剥离
    ...(data?.canSeeValue
      ? ([
          {
            /* 排序一律 `sorter: true`（服务端序）：AntD 的本地比较器只排当前一页，
               而分页总数来自服务端——第 8 页那笔最贵的永远浮不上来。 */
            title: "在库金额",
            dataIndex: "amount",
            width: 120,
            align: "right" as const,
            sorter: true,
            sortOrder: (sort === "amount" ? "descend" : null) as "descend" | null,
            render: (v: string | null | undefined) =>
              v == null ? <Typography.Text type="secondary">无成本</Typography.Text> : formatYuan(v),
          },
          {
            title: "风险金额",
            dataIndex: "atRiskAmount",
            width: 120,
            align: "right" as const,
            sorter: true,
            sortOrder: (sort === "atRiskAmount" ? "descend" : null) as "descend" | null,
            render: (v: string | null | undefined) =>
              v == null
                ? <Typography.Text type="secondary">无成本</Typography.Text>
                : (
                  <Tooltip title="阈值内到期量（含已过期）× 单位成本；按它排序时由服务端在全部结果上排完再分页——第 1 页就是全局最贵的那些，无成本的行排在最后（不按 ¥0 参与比较）">
                    <Typography.Text strong={Number(v) > 0}>{formatYuan(v)}</Typography.Text>
                  </Tooltip>
                ),
          },
        ] as ColumnsType<RiskRow>)
      : []),
    {
      title: "最短剩余效期",
      dataIndex: "minDaysLeft",
      width: 115,
      align: "right",
      render: (v: number | null, r) =>
        v == null ? "—" : v <= 0 ? (
          <Typography.Text type="danger" strong>已过期 {-v} 天</Typography.Text>
        ) : v <= r.nearExpiryDays ? (
          <Tooltip title={`该 SKU 临期阈值 ${r.nearExpiryDays} 天`}>
            <Typography.Text type="warning">{v} 天</Typography.Text>
          </Tooltip>
        ) : (
          `${v} 天`
        ),
    },
    { title: "过期量", dataIndex: "expiredQty", width: 90, align: "right", render: (v: number) => (v > 0 ? <Typography.Text type="danger">{v.toLocaleString("zh-CN")}</Typography.Text> : "—") },
    {
      title: "阈值内到期量",
      dataIndex: "nearQty",
      width: 120,
      align: "right",
      render: (v: number, r) => (
        <Tooltip title={`临期阈值 ${r.nearExpiryDays} 天`}>
          <span>{v > 0 ? v.toLocaleString("zh-CN") : "—"}</span>
        </Tooltip>
      ),
    },
    { title: "日均销", dataIndex: "daily", width: 85, align: "right" },
    {
      title: "外部近30天",
      dataIndex: "externalNet30",
      width: 105,
      align: "right",
      render: (v: string | null, r) => v == null
        ? <Typography.Text type="secondary">未映射</Typography.Text>
        : (
          <Tooltip title={`简道云天猫观察净需求，最近售出 ${r.externalLastSold ?? "—"}；内部判无动销而外部仍在售的，处置前先核对`}>
            <Typography.Text type={Number(v) > 0 && r.cover == null ? "danger" : undefined} strong={Number(v) > 0 && r.cover == null}>{Number(v).toLocaleString("zh-CN")}</Typography.Text>
          </Tooltip>
        ),
    },
    {
      title: "可销天数",
      dataIndex: "cover",
      width: 95,
      align: "right",
      render: (v: number | null) => (v == null ? <Typography.Text type="secondary">无动销</Typography.Text> : Math.round(v).toLocaleString("zh-CN")),
    },
    {
      title: "处置登记",
      width: 150,
      render: (_, r) =>
        r.disposalOpen ? (
          <Space size={6}>
            <Tag color="green" style={{ marginInlineEnd: 0 }}>已登记</Tag>
            <Tooltip title={`前往执行入口：${EXEC_ROUTE(r).label}`}>
              <a href={EXEC_ROUTE(r).href}>去执行</a>
            </Tooltip>
            <Popconfirm title={`确认 ${r.code} 实物处置已完成、关闭登记？`} onConfirm={() => {
              void postJson("/api/report/risk", { intent: "close", skuCode: r.code })
                .then(() => { message.success(`${r.code} 处置登记已关闭`); void load(); })
                .catch((e) => message.error((e as Error).message));
            }}><a>完成</a></Popconfirm>
          </Space>
        ) : (
          <Dropdown
            trigger={["click"]}
            menu={{
              items: ACTION_ORDER.map((a) => ({ key: a, label: a === r.action ? `${a}（建议）` : a })),
              onClick: ({ key }) => {
                void postJson("/api/report/risk", { skuCode: r.code, action: key, note: r.palletRemark ?? undefined })
                  .then(() => { message.success(`${r.code} 登记为「${key}」`); void load(); })
                  .catch((e) => message.error((e as Error).message));
              },
            }}
          >
            <a onClick={(e) => e.preventDefault()}>登记处置 ▾</a>
          </Dropdown>
        ),
    },
    {
      title: "货盘注记",
      dataIndex: "palletRemark",
      ellipsis: true,
      render: (v: string | null, r) =>
        v ? (
          <Tooltip title={`${v}（${r.remarkMonth ?? "月份未知"} 货盘表）`}>
            <span>{v}</span>
          </Tooltip>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>风险库存处置</Typography.Title>
      <CaliberNote
        summary={<>效期 × 货盘注记 × 销速三源融合的处置建议；只读不开单，登记处置后到各单据执行。{data ? <>　口径日 {data.today}，滞销阈值 {data.slowThreshold} 天。</> : null}{data?.moneyCalibre ? <>　金额口径 {data.moneyCalibre.key}{data.costCoverage ? <>，成本覆盖 {data.costCoverage.covered}/{data.costCoverage.total} 行</> : null}。</> : null}</>}
        detail={
          <div>
            <p>三源：批次效期（batch_stocks）× 货盘处置注记（PMC 货盘表备注原文）× 近 3 月销速。动作优先级：报废评审 → 禁售隔离 → 商务处置 → 促销清库 → 优先出库 → 滞销关注。</p>
            <p>报废登记可直接创建绑定的报废出库单；审批过账后登记自动完成，红字冲销后自动重开。其他处置仍走对应业务页并人工收口。</p>
            {/* 金额口径文案唯一权威在服务端（report/risk.ts 的 RISK_MONEY_CALIBRE），前端不得另写一份 */}
            {data?.moneyCalibre ? (
              <>
                <p><b>金额口径（{data.moneyCalibre.key}）</b></p>
                <p>· {data.moneyCalibre.costSource}</p>
                <p>· {data.moneyCalibre.amountBasis}</p>
                <p>· {data.moneyCalibre.atRiskBasis}</p>
                <p>· {data.moneyCalibre.asOfNote}</p>
                <p>· {data.moneyCalibre.precisionNote}</p>
                <p>· {data.moneyCalibre.sortNote}</p>
                {data.costCoverage ? (
                  <p>· 本次筛选下有单位成本的行：{data.costCoverage.covered}/{data.costCoverage.total}；其余行金额为空（不是 ¥0）。</p>
                ) : null}
              </>
            ) : null}
          </div>
        }
      />
      <ListToolbar
        state={listState}
        onExport={() => void doExport()}
        primaryActions={
          /* W2-4：页脚一直在推销的「导出任务」现在真的有入口（EXPORT_KINDS.risk） */
          <AsyncExportButton kind="risk" params={{ q, ...(action ? { action } : {}) }} />
        }
        extra={
          <>
            {ACTION_ORDER.map((a) => (
              <Tag.CheckableTag
                key={a}
                checked={action === a}
                onChange={(c) => listState.setFilter({ action: c ? a : "" })}
                style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}
              >
                {a}（{data?.byAction[a] ?? 0}）
              </Tag.CheckableTag>
            ))}
            <SearchInput
              key={q}
              allowClear
              defaultValue={q}
              placeholder="搜索编码/名称"
              style={{ width: 240 }}
              onSearch={(v) => listState.setFilter({ q: v.trim() })}
            />
          </>
        }
      />
      {selected.length > 0 ? (
        <div style={{ position: "sticky", top: 0, zIndex: 2, marginBottom: 8, padding: "8px 12px", background: "#e6f4ff", borderRadius: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography.Text>已选 {selected.length} 行（{selected.filter((r) => !r.disposalOpen).length} 项可登记）</Typography.Text>
          <Space>
            <Button size="small" onClick={() => setSelected([])}>清除</Button>
            <Popconfirm title={`将为 ${selected.filter((r) => !r.disposalOpen).length} 个 SKU 按其建议动作批量登记处置决定？`} onConfirm={() => void bulkRegister()}>
              <Button size="small" type="primary" loading={registering}>批量登记处置</Button>
            </Popconfirm>
          </Space>
        </div>
      ) : null}
      <Table<RiskRow>
        rowKey="skuId"
        size={listState.tableSize}
        columns={columns}
        dataSource={data?.rows ?? []}
        loading={loading}
        scroll={{ x: "max-content" }}
        rowSelection={{
          selectedRowKeys: selected.map((r) => r.skuId),
          preserveSelectedRowKeys: true,
          onChange: (_keys, rows) => setSelected(rows.filter((r) => r != null)),
          getCheckboxProps: (r) => ({ disabled: r.disposalOpen }),
        }}
        pagination={listState.paginationProps({ total: data?.total ?? 0 })}
        onChange={(_pagination, _filters, sorter) => {
          /* 排序键写回 URL，由服务端在全集上排序；取消排序回落动作优先级序 */
          const s = Array.isArray(sorter) ? sorter[0] : sorter;
          const field = typeof s?.field === "string" ? s.field : "";
          const next = s?.order && (field === "amount" || field === "atRiskAmount") ? field : "action";
          if (next !== sort) listState.setFilter({ sort: next });
        }}
      />
    </div>
  );
}
