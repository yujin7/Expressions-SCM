"use client";

/**
 * 分域覆盖（sku > brand > segment > global > 系统缺省）——2026-09-04 审计 #3。
 *
 * `core/scoped-params.ts` 与 `/api/admin/params/scoped` 早就实现并测过整套作用域继承，
 * 却**没有任何前端调用它**：/admin/params 只读 `scope='global'`，
 * 已经存在的 sku/brand/segment 覆盖在页面上完全不可见——业务看到 45 天，
 * 引擎对某个品牌用的是 30 天，两个数互相解释不了。这张卡片补上读与写。
 *
 * 全局层保护不在这里放宽：表单不提供 global 选项，服务端也仍然拒绝
 * 非 admin 经本路径改 global（那条路是 `/api/admin/params` 的 admin-only 闸）。
 */
import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Empty, InputNumber, Popconfirm, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import { fetchJson } from "@/components/fetchJson";
import RemoteSelect from "@/components/RemoteSelect";

export type ScopeKind = "sku" | "brand" | "segment" | "category";

export interface ScopedParamKey {
  key: string;
  label: string;
  unit: string;
  /** 枚举参数无 min/max（它们也不分域，不会出现在选择器里） */
  min?: number;
  max?: number;
  fallback: number | string;
  scopeKinds: ScopeKind[];
  categoryOptions: readonly { value: string; label: string }[];
}

interface OverrideRow {
  scope: string;
  kind: string;
  target: string;
  label: string;
  value: number;
  lastChangedBy: string | null;
  lastChangedAt: string | null;
}

const KIND_LABEL: Record<ScopeKind, string> = {
  sku: "SKU",
  brand: "品牌",
  segment: "分层格",
  category: "品类",
};

/** 九宫格分层格（ABC × XYZ）——与 report/segmentation 的格名同域 */
const SEGMENT_CELLS = ["AX", "AY", "AZ", "BX", "BY", "BZ", "CX", "CY", "CZ"];

export default function ScopedOverridesCard({
  params,
  canWrite,
  selectedKey,
  onSelectKey,
  onChanged,
}: {
  params: ScopedParamKey[];
  canWrite: boolean;
  selectedKey: string | null;
  onSelectKey: (key: string) => void;
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<OverrideRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<ScopeKind | null>(null);
  const [target, setTarget] = useState<string | number | null>(null);
  const [value, setValue] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const def = params.find((p) => p.key === selectedKey) ?? null;
  const overridable = params.filter((p) => p.scopeKinds.length > 0);

  const load = useCallback(async () => {
    if (!selectedKey) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetchJson<{ rows: OverrideRow[] }>(
        `/api/admin/params/scoped?key=${encodeURIComponent(selectedKey)}`,
      );
      setRows(res.rows);
    } catch (e) {
      message.error((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [selectedKey, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // 换参数时重置表单：不同参数的层与量纲都不同，留着上一个的目标只会误提交
  useEffect(() => {
    setKind(def?.scopeKinds[0] ?? null);
    setTarget(null);
    setValue(def && typeof def.fallback === "number" ? def.fallback : null);
  }, [def]);

  const scopeBody = (): Record<string, unknown> | null => {
    if (!kind || target == null || target === "") return null;
    if (kind === "sku") return { kind, skuId: Number(target) };
    if (kind === "brand") return { kind, brandId: Number(target) };
    if (kind === "segment") return { kind, cell: String(target) };
    return { kind, category: String(target) };
  };

  const submit = async () => {
    const scope = scopeBody();
    if (!def || !scope) return void message.warning("请先选择覆盖目标");
    if (value == null) return void message.warning("请填写覆盖值");
    setSaving(true);
    try {
      await fetchJson("/api/admin/params/scoped", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: def.key, value, scope }),
      });
      message.success(`「${def.label}」覆盖已保存`);
      setTarget(null);
      await load();
      onChanged();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: OverrideRow) => {
    if (!def) return;
    const [k, rest = ""] = row.scope.split(":");
    const scope =
      k === "sku" ? { kind: "sku", skuId: Number(rest) }
        : k === "brand" ? { kind: "brand", brandId: Number(rest) }
          : k === "segment" ? { kind: "segment", cell: rest }
            : { kind: "category", category: rest };
    try {
      await fetchJson("/api/admin/params/scoped", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: def.key, scope }),
      });
      message.success(`已清除「${row.label}」的覆盖，回落上一级`);
      await load();
      onChanged();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const columns: ColumnsType<OverrideRow> = [
    { title: "层", dataIndex: "kind", width: 90, render: (v: string) => <Tag>{KIND_LABEL[v as ScopeKind] ?? v}</Tag> },
    { title: "目标", dataIndex: "target", ellipsis: true, render: (v: string, r) => v || r.label },
    {
      title: "覆盖值",
      dataIndex: "value",
      width: 130,
      render: (v: number) => (
        <Space size={4}>
          <Typography.Text strong>{v}</Typography.Text>
          <Typography.Text type="secondary">{def?.unit}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "最近修改",
      width: 200,
      render: (_, r) => (r.lastChangedAt ? `${r.lastChangedBy ?? "?"} · ${r.lastChangedAt}` : "—"),
    },
    {
      title: "",
      width: 90,
      render: (_, r) =>
        canWrite ? (
          <Popconfirm title={`清除「${r.label}」的覆盖？该目标将回落上一级值。`} onConfirm={() => void remove(r)}>
            <Button size="small" danger>清除</Button>
          </Popconfirm>
        ) : null,
    },
  ];

  const targetPicker = () => {
    if (kind === "sku") {
      return (
        <RemoteSelect
          api="/api/master/sku"
          getLabel={(r) => `${String(r.code)} ${String(r.name ?? "")}`}
          placeholder="选择 SKU"
          style={{ width: 260 }}
          showSearch
          value={target ?? undefined}
          onChange={(v) => setTarget(v as number)}
        />
      );
    }
    if (kind === "brand") {
      return (
        <RemoteSelect
          api="/api/master/brand"
          getLabel={(r) => `${String(r.code)} ${String(r.nameCn ?? "")}`}
          placeholder="选择品牌"
          style={{ width: 220 }}
          showSearch
          value={target ?? undefined}
          onChange={(v) => setTarget(v as number)}
        />
      );
    }
    if (kind === "segment") {
      return (
        <Select
          placeholder="选择分层格"
          style={{ width: 140 }}
          options={SEGMENT_CELLS.map((c) => ({ value: c, label: `${c} 格` }))}
          value={(target as string) ?? undefined}
          onChange={(v) => setTarget(v)}
        />
      );
    }
    if (kind === "category") {
      return (
        <Select
          placeholder="选择品类"
          style={{ width: 140 }}
          options={[...(def?.categoryOptions ?? [])]}
          value={(target as string) ?? undefined}
          onChange={(v) => setTarget(v)}
        />
      );
    }
    return null;
  };

  return (
    <Card
      size="small"
      title="分域覆盖（SKU / 品牌 / 分层格 / 品类）"
      style={{ marginBottom: 16 }}
      extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        解析顺序：SKU &gt; 品牌 &gt; 分层格 &gt; 全局 &gt; 系统缺省。覆盖只影响命中的目标，
        清除后立即回落上一级。全局值仍只能在上方主表里改（管理员专用闸，本卡片不提供 global 层）。
        品类层只服务于按品类维护的参数（如结算损耗率，缺品类行＝不扣损耗，不回落全局）。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="选择参数"
          style={{ width: 240 }}
          value={selectedKey ?? undefined}
          options={overridable.map((p) => ({ value: p.key, label: p.label }))}
          onChange={(v) => onSelectKey(v)}
        />
        {def && canWrite ? (
          <>
            <Select
              style={{ width: 120 }}
              value={kind ?? undefined}
              options={def.scopeKinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
              onChange={(v) => {
                setKind(v);
                setTarget(null);
              }}
            />
            {targetPicker()}
            <InputNumber
              min={def.min}
              max={def.max}
              value={value}
              onChange={(v) => setValue(v == null ? null : Number(v))}
              style={{ width: 120 }}
              addonAfter={def.unit || undefined}
            />
            <Button type="primary" loading={saving} onClick={() => void submit()}>
              保存覆盖
            </Button>
          </>
        ) : null}
      </Space>
      {selectedKey ? (
        <Table<OverrideRow>
          rowKey="scope"
          size="small"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={false}
          locale={{ emptyText: "该参数尚无分域覆盖：全部目标都用全局值" }}
        />
      ) : (
        <Empty description="选择一个参数查看它的分域覆盖" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </Card>
  );
}
