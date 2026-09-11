"use client";

import ListToolbar from "@/components/ListToolbar";
import SearchInput from "@/components/SearchInput";
import LoadErrorAlert from "@/components/LoadErrorAlert";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, App, Badge, Button, Empty, Input, Modal, Popconfirm, Progress, Select, Space, Table, Tabs, Tag, Tooltip, Typography, Upload,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, UploadOutlined } from "@ant-design/icons";
import { fetchJson, patchJson, postJson } from "@/components/fetchJson";
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

interface ImportResult {
  parsed: number;
  inserted: number;
  skipped: number;
  byCategory: { category: string; count: number }[];
}

/**
 * W2 代决清单导入（仅管理员）。
 *
 * 此前空态写的是「请管理员运行那个 seed 脚本」——那个脚本要 SSH 进机器、
 * 停掉 dev server、还得先把那份 md 放上去，等于在应用里**没有任何**填充队列的办法，
 * 「复核清单」对所有实际使用者都是一张只读空页。现在同一个解析器、同一条按 title 的幂等规则
 * 搬进应用，并且比脚本多一条：同事务写审计（谁导的、导了多少、来源是什么）。
 */
function ImportChecklistModal({ open, onCancel, onDone }: {
  open: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [markdown, setMarkdown] = useState("");
  const [source, setSource] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    if (!open) { setMarkdown(""); setSource(""); setResult(null); }
  }, [open]);

  const pickFile = async (file: File) => {
    setSource(file.name);
    setMarkdown(await file.text());
    return false as const; // 只读取内容，不上传
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await postJson<ImportResult>("/api/review/checklist/import", {
        markdown,
        source: source.trim() || undefined,
      });
      setResult(res);
      message.success(`已导入：新增 ${res.inserted} 条，跳过已存在 ${res.skipped} 条`);
      onDone();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="导入代决清单"
      open={open}
      okText={result ? "关闭" : "导入"}
      cancelButtonProps={{ style: result ? { display: "none" } : undefined }}
      cancelText="取消"
      confirmLoading={submitting}
      onCancel={onCancel}
      onOk={result ? onCancel : () => void submit()}
      okButtonProps={{ disabled: !result && markdown.trim().length === 0 }}
      width={720}
    >
      {result ? (
        <Alert
          type="success"
          showIcon
          message={`解析 ${result.parsed} 条：新增 ${result.inserted}，跳过已存在 ${result.skipped}`}
          description={
            result.byCategory.length > 0
              ? <Space wrap>{result.byCategory.map((c) => <Tag key={c.category}>{CATEGORY_LABELS[c.category] ?? c.category} {c.count}</Tag>)}</Space>
              : "本次没有新增条目（全部已存在）——本导入按事项标题幂等，可以反复执行。"
          }
        />
      ) : (
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="按事项标题幂等，可反复导入；本操作只导入，不生成、不推断任何复核项"
            description="识别以「- 」开头的条目行（代决清单 md 格式）；前缀决定类别（SPU 簇代决 / BOM 歧义代决 / 物料代决分类 / 壳档 / 放行受阻 / BOM 生效抽检 / 无编码物料），其余归「其他」。"
          />
          <Space>
            <Upload accept=".md,.txt,.markdown" maxCount={1} showUploadList={false} beforeUpload={pickFile}>
              <Button icon={<UploadOutlined />}>选择 md 文件</Button>
            </Upload>
            <Input
              style={{ width: 300 }}
              maxLength={200}
              placeholder="来源标签（进审计，如文件名）"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </Space>
          <Input.TextArea
            rows={10}
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            placeholder={"或直接粘贴内容，例如：\n- SPU 簇代决：N006-001（同名两簇合并）——待业务确认"}
          />
        </Space>
      )}
    </Modal>
  );
}

export default function ChecklistClient() {
  const me = useMe();
  const canDecide = hasAnyRole(me, "pmc", "purchasing", "warehouse", "finance");
  // 导入是跨域主数据裁决的入口，与服务端 REVIEW_IMPORT_ROLES 同口径：仅管理员
  const canImport = me?.roles?.includes("admin") === true;
  const [importOpen, setImportOpen] = useState(false);
  const { message } = App.useApp();

  const [counts, setCounts] = useState<CountRow[] | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const countRequest = useRef<AbortController | null>(null);
  const listState = useListState({ key: "checklist", defaults: { q: "", category: "all", status: "open", id: "" }, defaultPageSize: 20 });
  const { filters, page, pageSize } = listState;
  const q = filters.q;
  const category = filters.category;
  const status = filters.status;
  const focusId = filters.id;
  const [rows, setRows] = useState<ReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const latestLoad = useRef<() => Promise<void>>(async () => {});
  const [selected, setSelected] = useState<number[]>([]);
  const [overruling, setOverruling] = useState<ReviewItem | null>(null);
  const [overruleNote, setOverruleNote] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const loadCounts = useCallback(async () => {
    countRequest.current?.abort();
    const request = new AbortController();
    countRequest.current = request;
    setCountError(null);
    try {
      const res = await fetchJson<{ counts: CountRow[] }>("/api/review/checklist/counts", { signal: request.signal });
      if (!request.signal.aborted) setCounts(res.counts);
    } catch (e) {
      if (!request.signal.aborted) setCountError((e as Error).message);
    }
  }, []);

  const load = useCallback(async () => {
    loadRequest.current?.abort();
    const request = new AbortController();
    loadRequest.current = request;
    setLoading(true);
    setLoadError(null);
    setSelected([]);
    try {
      const params = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
      if (focusId) params.set("id", focusId);
      if (category !== "all") params.set("category", category);
      if (status !== "all") params.set("status", status);
      const res = await fetchJson<{ data: ReviewItem[]; total: number }>(`/api/review/checklist?${params}`, { signal: request.signal });
      if (!request.signal.aborted) { setRows(res.data); setTotal(res.total); }
    } catch (e) {
      if (!request.signal.aborted) setLoadError((e as Error).message);
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [q, page, pageSize, category, status, focusId]);

  useEffect(() => {
    void loadCounts();
    return () => { countRequest.current?.abort(); };
  }, [loadCounts]);
  useEffect(() => {
    latestLoad.current = load;
    void load();
    return () => { loadRequest.current?.abort(); latestLoad.current = async () => {}; };
  }, [load]);

  const reload = useCallback(() => {
    void latestLoad.current();
    void loadCounts();
  }, [loadCounts]);

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
    for (const c of counts ?? []) {
      bump(c.category, c.status, c.count);
      bump("all", c.status, c.count);
    }
    return agg;
  }, [counts]);

  const current = catAgg.get(category) ?? { open: 0, done: 0, overruled: 0, total: 0 };
  const processed = current.done + current.overruled;
  const pct = current.total ? Math.round((processed / current.total) * 100) : 0;

  const decide = async (id: number, st: string, note?: string) => {
    if (savingRef.current || loading || loadError) return;
    savingRef.current = true;
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
      savingRef.current = false;
      setSaving(false);
    }
  };

  const bulkPass = async () => {
    if (savingRef.current || loading || loadError || !selected.length) return;
    savingRef.current = true;
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
      savingRef.current = false;
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
        canDecide && !loadError && !loading ? (
          <Space size={0}>
            {r.status === "open" && (
              <>
                <Button type="link" size="small" disabled={saving} onClick={() => void decide(r.id, "done")}>
                  通过
                </Button>
                <Button
                  type="link"
                  size="small"
                  disabled={saving}
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
                <Button type="link" size="small" disabled={saving}>
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
    disabled: !!focusId,
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
      <LoadErrorAlert error={countError} onRetry={() => void loadCounts()} subject="复核统计" />
      {!focusId && counts !== null && !countError ? <Space style={{ marginBottom: 12 }} size="large" wrap>
        <Progress type="circle" size={56} percent={pct} />
        <div>
          <div>
            {category === "all" ? "全部" : CATEGORY_LABELS[category]}：已处理 {processed} / {current.total}
          </div>
          <Typography.Text type="secondary">
            待复核 {current.open} · 已通过 {current.done} · 已改判 {current.overruled}
          </Typography.Text>
        </div>
      </Space> : null}
      <Tabs
        activeKey={category}
        items={tabItems}
        onChange={(k) => {
          listState.setFilter({ category: k });
        }}
      />
      <ListToolbar
        state={listState}
        extra={
          <>
            {focusId ? <Tag color="processing" closable onClose={() => listState.setFilter({ id: "" })}>仅看复核 #{focusId}（忽略其他筛选）</Tag> : null}
            <SearchInput
              key={q}
              defaultValue={q}
              disabled={!!focusId}
              allowClear
              placeholder="搜索事项/详情/编码"
              style={{ width: 280 }}
              onSearch={(v) => {
                listState.setFilter({ q: v.trim() });
              }}
            />
            <Select
              disabled={!!focusId}
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
          </>
        }
        primaryActions={
          <>
            <Button icon={<ReloadOutlined />} onClick={reload}>
              刷新
            </Button>
            {canImport ? (
              <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
                导入代决清单
              </Button>
            ) : null}
            {canDecide ? (
              <Popconfirm
                title={`批量通过选中的 ${selected.length} 条？`}
                okText="通过"
                cancelText="取消"
                onConfirm={() => void bulkPass()}
              >
                <Button type="primary" disabled={!selected.length || loading || !!loadError} loading={saving}>
                  批量通过（{selected.length}）
                </Button>
              </Popconfirm>
            ) : null}
          </>
        }
      />
      <LoadErrorAlert error={loadError} onRetry={reload} subject="复核清单" retrying={loading} />
      <Table<ReviewItem>
        rowKey="id"
        size={listState.tableSize}
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: "max-content" }}
        locale={{
          /* 空态此前写着「请管理员运行那个 seed 脚本」——一个用户在应用里
             永远做不到的动作。现在导入就在本页上（管理员可见），非管理员看到的是
             「找谁」而不是「跑什么命令」。 */
          emptyText: loadError ? "数据未加载" : focusId ? "未找到该来源复核项，请核对链接或联系负责人。" : (
            <Empty
              description={
                canImport
                  ? "暂无复核项——可用右上角「导入代决清单」把代决记录导进来（按标题幂等，可反复导入）"
                  : "暂无复核项——代决清单由管理员在本页「导入代决清单」导入；业务流程（风险处置、委外余料、页面反馈）产生的复核项会自动出现在这里"
              }
            >
              {canImport ? (
                <Button type="primary" icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
                  导入代决清单
                </Button>
              ) : null}
            </Empty>
          ),
        }}
        rowSelection={
          canDecide
            ? {
                selectedRowKeys: selected,
                onChange: (keys) => setSelected(keys as number[]),
                getCheckboxProps: (r) => ({ disabled: r.status !== "open" || loading || !!loadError || saving }),
              }
            : undefined
        }
        pagination={focusId ? false : listState.paginationProps({ total, showTotal: (t) => `共 ${t} 条` })}
      />
      <ImportChecklistModal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onDone={reload}
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
