"use client";

import SearchInput from "@/components/SearchInput";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  App, Badge, Button, Empty, Input, Modal, Popconfirm, Progress, Select, Space, Table, Tabs, Tag, Tooltip, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import { fetchJson, patchJson } from "@/components/fetchJson";
import { hasAnyRole, useMe } from "@/components/useMe";
import { useListState } from "@/components/useListState";

/** 类别标签（新文件承载——共享 labels.ts 不动） */
const CATEGORY_LABELS: Record<string, string> = {
  spu_cluster: "SPU 簇代决",
  bom_version: "BOM 歧义代决",
  segment: "物料代决分类",
  shell_brand: "壳档品牌",
  blocked_sku: "放行受阻",
  activation_sample: "BOM 生效抽检",
  uncoded: "无编码物料",
  other: "其他",
};
const CATEGORY_ORDER = [
  "spu_cluster", "bom_version", "segment", "shell_brand", "blocked_sku", "activation_sample", "uncoded", "other",
];
const STATUS_LABELS: Record<string, string> = { open: "待复核", done: "已通过", overruled: "已改判" };
const STATUS_COLORS: Record<string, string> = { open: "processing", done: "success", overruled: "warning" };

interface ReviewItem {
  id: number;
  category: string;
  refType: string | null;
  refKey: string | null;
  title: string;
  detail: string | null;
  status: string;
  note: string | null;
  decidedBy: number | null;
  decidedAt: string | null;
}

interface CountRow {
  category: string;
  status: string;
  count: number;
}

function refLink(r: ReviewItem): React.ReactNode {
  if (!r.refKey) return "—";
  const q = encodeURIComponent(r.refKey);
  if (r.refType === "sku") return <a href={`/inventory/balance?q=${q}`}>{r.refKey}</a>;
  if (r.refType === "bom") return <a href={`/master/bom?q=${q}`}>{r.refKey}</a>;
  return r.refKey;
}

export default function ChecklistClient() {
  const me = useMe();
  const canDecide = hasAnyRole(me, "pmc", "purchasing", "warehouse", "finance");
  const { message } = App.useApp();

  const [counts, setCounts] = useState<CountRow[]>([]);
  const listState = useListState({ key: "checklist", defaults: { q: "", category: "all", status: "open" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const category = filters.category;
  const status = filters.status;
  const [rows, setRows] = useState<ReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [overruling, setOverruling] = useState<ReviewItem | null>(null);
  const [overruleNote, setOverruleNote] = useState("");
  const [saving, setSaving] = useState(false);

  const loadCounts = useCallback(async () => {
    try {
      const res = await fetchJson<{ counts: CountRow[] }>("/api/review/checklist/counts");
      setCounts(res.counts);
    } catch (e) {
      message.error((e as Error).message);
    }
  }, [message]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (category !== "all") params.set("category", category);
      if (status !== "all") params.set("status", status);
      const res = await fetchJson<{ data: ReviewItem[]; total: number }>(`/api/review/checklist?${params}`);
      setRows(res.data);
      setTotal(res.total);
      setSelected([]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, category, status, message]);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);
  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(() => {
    void load();
    void loadCounts();
  }, [load, loadCounts]);

  /** 类别聚合：{cat: {open, done, overruled, total}} */
  const catAgg = useMemo(() => {
    const agg = new Map<string, { open: number; done: number; overruled: number; total: number }>();
    const bump = (cat: string, st: string, n: number) => {
      const cur = agg.get(cat) ?? { open: 0, done: 0, overruled: 0, total: 0 };
      if (st === "open") cur.open += n;
      else if (st === "done") cur.done += n;
      else if (st === "overruled") cur.overruled += n;
      cur.total += n;
      agg.set(cat, cur);
    };
    for (const c of counts) {
      bump(c.category, c.status, c.count);
      bump("all", c.status, c.count);
    }
    return agg;
  }, [counts]);

  const current = catAgg.get(category) ?? { open: 0, done: 0, overruled: 0, total: 0 };
  const processed = current.done + current.overruled;
  const pct = current.total ? Math.round((processed / current.total) * 100) : 0;

  const decide = async (id: number, st: string, note?: string) => {
    setSaving(true);
    try {
      await patchJson(`/api/review/checklist/${id}`, { status: st, note });
      message.success(st === "open" ? "已重开" : st === "done" ? "已通过" : "已改判");
      setOverruling(null);
      setOverruleNote("");
      reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const bulkPass = async () => {
    setSaving(true);
    try {
      const res = await patchJson<{ updated: number }>("/api/review/checklist", {
        ids: selected,
        status: "done",
      });
      message.success(`已批量通过 ${res.updated} 条`);
      reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<ReviewItem> = [
    {
      title: "类别",
      dataIndex: "category",
      width: 130,
      render: (v: string) => <Tag>{CATEGORY_LABELS[v] ?? v}</Tag>,
    },
    {
      title: "事项",
      dataIndex: "title",
      ellipsis: { showTitle: false },
      render: (v: string) => (
        <Tooltip title={v} placement="topLeft">
          {v}
        </Tooltip>
      ),
    },
    {
      title: "详情",
      dataIndex: "detail",
      width: 320,
      ellipsis: { showTitle: false },
      render: (v: string | null) =>
        v ? (
          <Tooltip title={v} placement="topLeft">
            <Typography.Text type="secondary" style={{ maxWidth: 300 }} ellipsis>
              {v}
            </Typography.Text>
          </Tooltip>
        ) : (
          "—"
        ),
    },
    { title: "关联编码", key: "refKey", width: 170, render: (_, r) => refLink(r) },
    {
      title: "状态",
      dataIndex: "status",
      width: 90,
      render: (v: string) => <Tag color={STATUS_COLORS[v]}>{STATUS_LABELS[v] ?? v}</Tag>,
    },
    {
      title: "复核意见",
      dataIndex: "note",
      width: 160,
      ellipsis: { showTitle: false },
      render: (v: string | null) =>
        v ? (
          <Tooltip title={v} placement="topLeft">
            {v}
          </Tooltip>
        ) : (
          "—"
        ),
    },
    {
      title: "操作",
      key: "_actions",
      width: 170,
      render: (_, r) =>
        canDecide ? (
          <Space size={0}>
            {r.status === "open" && (
              <>
                <Button type="link" size="small" onClick={() => void decide(r.id, "done")}>
                  通过
                </Button>
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    setOverruling(r);
                    setOverruleNote(r.note ?? "");
                  }}
                >
                  改判
                </Button>
              </>
            )}
            {r.status !== "open" && (
              <Popconfirm title="重开该复核项？" okText="重开" cancelText="取消" onConfirm={() => void decide(r.id, "open")}>
                <Button type="link" size="small">
                  重开
                </Button>
              </Popconfirm>
            )}
          </Space>
        ) : (
          <Typography.Text type="secondary">只读</Typography.Text>
        ),
    },
  ];

  const tabItems = ["all", ...CATEGORY_ORDER.filter((c) => catAgg.has(c))].map((c) => ({
    key: c,
    label: (
      <Badge count={catAgg.get(c)?.open ?? 0} size="small" offset={[6, -2]} overflowCount={9999}>
        <span style={{ paddingRight: 4 }}>{c === "all" ? "全部" : CATEGORY_LABELS[c] ?? c}</span>
      </Badge>
    ),
  }));

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        在案复核清单
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        数据填充期自动代决记录（SPU 归簇 / BOM 版本裁决 / 物料分类 / 壳档品牌等）在案复核；改判后请经红字或重导修正业务数据。
      </Typography.Paragraph>
      <Space style={{ marginBottom: 12 }} size="large" wrap>
        <Progress type="circle" size={56} percent={pct} />
        <div>
          <div>
            {category === "all" ? "全部" : CATEGORY_LABELS[category]}：已处理 {processed} / {current.total}
          </div>
          <Typography.Text type="secondary">
            待复核 {current.open} · 已通过 {current.done} · 已改判 {current.overruled}
          </Typography.Text>
        </div>
      </Space>
      <Tabs
        activeKey={category}
        items={tabItems}
        onChange={(k) => {
          listState.setFilter({ category: k });
        }}
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <SearchInput
          allowClear
          placeholder="搜索事项/详情/编码"
          style={{ width: 280 }}
          onSearch={(v) => {
            listState.setFilter({ q: v.trim() });
          }}
        />
        <Select
          value={status}
          style={{ width: 120 }}
          onChange={(v) => {
            listState.setFilter({ status: v });
          }}
          options={[
            { value: "all", label: "全部状态" },
            { value: "open", label: "待复核" },
            { value: "done", label: "已通过" },
            { value: "overruled", label: "已改判" },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={reload}>
          刷新
        </Button>
        {canDecide && (
          <Popconfirm
            title={`批量通过选中的 ${selected.length} 条？`}
            okText="通过"
            cancelText="取消"
            onConfirm={() => void bulkPass()}
          >
            <Button type="primary" disabled={!selected.length} loading={saving}>
              批量通过（{selected.length}）
            </Button>
          </Popconfirm>
        )}
      </Space>
      <Table<ReviewItem>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        locale={{
          emptyText: (
            <Empty description="暂无复核项——如需导入代决清单，请管理员运行 seed-review-items 脚本" />
          ),
        }}
        rowSelection={
          canDecide
            ? {
                selectedRowKeys: selected,
                onChange: (keys) => setSelected(keys as number[]),
                getCheckboxProps: (r) => ({ disabled: r.status !== "open" }),
              }
            : undefined
        }
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            listState.setPage(p, ps);
          },
        }}
      />
      <Modal
        title={overruling ? `改判：${overruling.title}` : "改判"}
        open={!!overruling}
        okText="确认改判"
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => setOverruling(null)}
        onOk={() => {
          if (overruling) void decide(overruling.id, "overruled", overruleNote.trim() || undefined);
        }}
      >
        <Typography.Paragraph type="secondary">
          改判仅登记复核结论；业务数据修正请走红字冲销/重导流程。
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          maxLength={500}
          placeholder="复核意见（建议填写改判原因）"
          value={overruleNote}
          onChange={(e) => setOverruleNote(e.target.value)}
        />
      </Modal>
    </div>
  );
}
