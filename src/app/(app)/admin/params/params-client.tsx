"use client";

/** 运行参数（D39）：滞销/断货/补货阈值与 R 规则容差统一维护；改动即刻生效（60s 缓存内刷新） */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, InputNumber, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { BatchPostingRolloutCard } from "./BatchPostingRolloutCard";
import ScopedOverridesCard, { type ScopeKind } from "./scoped-overrides-card";

interface Row {
  key: string;
  /** number = 数值参数；enum = 枚举开关（如分层主口径 qty|value） */
  kind: "number" | "enum";
  label: string;
  value: number | string;
  fallback: number | string;
  /** 枚举参数没有 min/max（服务端不下发），数值参数必有 */
  min?: number;
  max?: number;
  unit: string;
  note: string;
  /** 枚举参数的可选项 */
  options?: { value: string; label: string }[];
  /** "category" = 只按品类维护，全局层只读（结算不读全局值） */
  scope?: "global" | "category";
  isDefault: boolean;
  lastChangedBy: string | null;
  lastChangedAt: string | null;
  /** D59：pmc 可写的补货键组 = "pmc"，其余 "admin" */
  writableBy?: "admin" | "pmc";
  /** 该键在 sku/brand/segment/category 层的覆盖行数 */
  overrideCount: number;
  scopeKinds: ScopeKind[];
  categoryOptions: { value: string; label: string }[];
}

export default function ParamsClient({ canWrite, isAdmin = canWrite }: { canWrite: boolean; isAdmin?: boolean }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<Record<string, number | string>>({});
  const [scopedKey, setScopedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ rows: Row[] }>("/api/admin/params");
      setRows(res.rows);
      setEdits({});
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (r: Row) => {
    const v = edits[r.key];
    if (v == null || v === r.value) return;
    try {
      await fetchJson("/api/admin/params", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: r.key, value: v }),
      });
      message.success(`「${r.label}」已更新为 ${v}${r.unit}`);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  /**
   * 逐键可写：admin 全部；pmc 仅 writableBy=pmc 的补货键组。
   * scope=category 的参数（损耗率）全局层本身不可写——结算只读品类行，
   * 在全局层填一个数只会让人以为改到了钱。
   */
  const writable = (r: Row): boolean =>
    canWrite && r.key !== "batch_posting_enabled" && r.scope !== "category" && (isAdmin || r.writableBy === "pmc");

  const scopedParams = useMemo(
    () => rows.map((r) => ({
      key: r.key,
      label: r.label,
      unit: r.unit,
      min: r.min,
      max: r.max,
      fallback: r.fallback,
      scopeKinds: r.scopeKinds ?? [],
      categoryOptions: r.categoryOptions ?? [],
    })),
    [rows],
  );

  const valueCell = (r: Row) => {
    if (r.kind === "enum") {
      return (
        <Select
          style={{ width: 200 }}
          value={String(edits[r.key] ?? r.value)}
          disabled={!writable(r)}
          options={r.options ?? []}
          onChange={(v) => setEdits((e) => ({ ...e, [r.key]: v }))}
        />
      );
    }
    return (
      <InputNumber
        min={r.min}
        max={r.max}
        value={Number(edits[r.key] ?? r.value)}
        disabled={!writable(r)}
        onChange={(v) => setEdits((e) => ({ ...e, [r.key]: Number(v) }))}
        style={{ width: 110 }}
      />
    );
  };

  const columns: ColumnsType<Row> = [
    { title: "参数", dataIndex: "label", width: 160 },
    {
      title: "最近修改",
      width: 190,
      render: (_: unknown, r: Row) =>
        r.lastChangedAt ? `${r.lastChangedBy ?? "?"} · ${r.lastChangedAt}` : "从未修改（默认值）",
    },
    {
      title: "当前值",
      width: 300,
      render: (_, r) => (
        <Space wrap>
          {valueCell(r)}
          {r.unit ? <Typography.Text type="secondary">{r.unit}</Typography.Text> : null}
          {r.key === "batch_posting_enabled" ? <Tag color="gold">专项闸门</Tag> : null}
          {r.scope === "category" ? (
            <Tooltip title="结算只读 category:<品类> 行；全局层没有读者，故只读">
              <Tag color="purple">按品类维护</Tag>
            </Tooltip>
          ) : null}
          {r.writableBy === "pmc" ? <Tag color="geekblue">生产计划可改</Tag> : null}
          {r.isDefault ? <Tag>缺省</Tag> : null}
          {r.overrideCount > 0 ? (
            <Tooltip title="该参数存在分域覆盖：命中的 SKU/品牌/分层格/品类用的不是这里的全局值">
              <Tag color="orange" style={{ cursor: "pointer" }} onClick={() => setScopedKey(r.key)}>
                有 {r.overrideCount} 处覆盖
              </Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: "",
      width: 90,
      render: (_, r) =>
        writable(r) ? (
          <Button
            size="small"
            type="primary"
            disabled={edits[r.key] == null || edits[r.key] === r.value}
            onClick={() => void save(r)}
          >
            保存
          </Button>
        ) : null,
    },
    {
      title: "取值范围",
      width: 150,
      render: (_, r) =>
        r.kind === "enum"
          ? (r.options ?? []).map((o) => o.value).join(" / ")
          : `${r.min}–${r.max}${r.unit}`,
    },
    { title: "说明", dataIndex: "note" },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        运行参数
      </Typography.Title>
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="阈值改动影响驾驶舱滞销判定、补货建议与断货预警（0724 会议 D39：滞销警戒阈值可配置）；R1/让步等规则容差同页维护。修改留审计。"
      />
      <BatchPostingRolloutCard canWrite={isAdmin} onActivated={() => void load()} />
      <Table<Row>
        rowKey="key"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        scroll={{ x: "max-content" }}
        style={{ marginBottom: 16 }}
      />
      <ScopedOverridesCard
        params={scopedParams}
        canWrite={canWrite}
        selectedKey={scopedKey}
        onSelectKey={setScopedKey}
        onChanged={() => void load()}
      />
    </div>
  );
}
