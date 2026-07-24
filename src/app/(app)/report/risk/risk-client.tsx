"use client";

/** F 项：风险库存处置工作台——效期批次 × 货盘处置注记 × 销速 三源融合（只读，spec/13） */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Dropdown, Input, Popconfirm, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson, postJson } from "@/components/fetchJson";
import { exportCsv } from "@/components/exportCsv";

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
  nearQty: number;
  palletRemark: string | null;
  remarkMonth: string | null;
  disposalOpen: boolean;
}

interface RiskData {
  today: string;
  slowThreshold: number;
  rows: RiskRow[];
  total: number;
  byAction: Record<string, number>;
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
    case "报废评审": return { href: `/inventory/expiry?q=${q}`, label: "查过期批次→走盘点/报废单" };
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
  const [q, setQ] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
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
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (action) params.set("action", action);
      setData(await fetchJson<RiskData>(`/api/report/risk?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, action, page, pageSize, message]);
  useEffect(() => { void load(); }, [load]);

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
          <a href={`/inventory/balance?q=${encodeURIComponent(v)}`}>{v}</a>
          {r.minDaysLeft != null ? <a href={`/inventory/expiry?q=${encodeURIComponent(v)}`} style={{ fontSize: 12 }}>批次</a> : null}
        </Space>
      ),
    },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    { title: "品牌", dataIndex: "brand", width: 100, render: (v: string | null) => v ?? "—" },
    { title: "在库", dataIndex: "onHand", width: 95, align: "right", render: (v: number) => v.toLocaleString("zh-CN") },
    {
      title: "最短剩余效期",
      dataIndex: "minDaysLeft",
      width: 115,
      align: "right",
      render: (v: number | null) =>
        v == null ? "—" : v <= 0 ? (
          <Typography.Text type="danger" strong>已过期 {-v} 天</Typography.Text>
        ) : v <= 90 ? (
          <Typography.Text type="warning">{v} 天</Typography.Text>
        ) : (
          `${v} 天`
        ),
    },
    { title: "过期量", dataIndex: "expiredQty", width: 90, align: "right", render: (v: number) => (v > 0 ? <Typography.Text type="danger">{v.toLocaleString("zh-CN")}</Typography.Text> : "—") },
    { title: "90天内到期量", dataIndex: "nearQty", width: 110, align: "right", render: (v: number) => (v > 0 ? v.toLocaleString("zh-CN") : "—") },
    { title: "日均销", dataIndex: "daily", width: 85, align: "right" },
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
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="三源融合（只读建议，不自动开单）：批次效期 × 货盘处置注记（PMC 货盘表备注） × 近3月销速。报废/禁售/盘点等操作走各自单据流程。"
        description={data ? <Typography.Text type="secondary">口径日 {data.today}；滞销阈值 {data.slowThreshold} 天（运行参数 slow_days_threshold）；注记为对应月份货盘表原文。</Typography.Text> : null}
      />
      <Space style={{ marginBottom: 12 }} wrap>
        {ACTION_ORDER.map((a) => (
          <Tag.CheckableTag
            key={a}
            checked={action === a}
            onChange={(c) => { setAction(c ? a : null); setPage(1); }}
            style={{ border: "1px solid #d9d9d9", padding: "2px 10px" }}
          >
            {a}（{data?.byAction[a] ?? 0}）
          </Tag.CheckableTag>
        ))}
        <Input.Search allowClear placeholder="搜索编码/名称" style={{ width: 240 }} onSearch={(v) => { setQ(v.trim()); setPage(1); }} />
        <a onClick={async () => {
          const all: RiskRow[] = [];
          for (let p2 = 1; p2 <= 10; p2++) {
            const params = new URLSearchParams({ q, page: String(p2), pageSize: "500" });
            if (action) params.set("action", action);
            const d = await fetchJson<RiskData>(`/api/report/risk?${params.toString()}`);
            all.push(...d.rows);
            if (all.length >= d.total) break;
          }
          exportCsv(`风险库存处置-${data?.today ?? ""}`,
            ["建议动作","SKU编码","名称","品牌","在库","最短剩余效期(天)","过期量","90天内到期量","日均销","可销天数","货盘注记","已登记"],
            all.map((r) => [r.action, r.code, r.name, r.brand, r.onHand, r.minDaysLeft, r.expiredQty, r.nearQty, r.daily, r.cover, r.palletRemark, r.disposalOpen ? "是" : ""]));
        }}>导出 CSV</a>
      </Space>
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
        size="small"
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
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
        }}
      />
    </div>
  );
}
