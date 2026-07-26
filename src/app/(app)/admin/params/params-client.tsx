"use client";

/** 运行参数（D39）：滞销/断货/补货阈值与 R 规则容差统一维护；改动即刻生效（60s 缓存内刷新） */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, InputNumber, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";

interface Row {
  key: string;
  label: string;
  value: number;
  fallback: number;
  min: number;
  max: number;
  unit: string;
  note: string;
  isDefault: boolean;
  lastChangedBy: string | null;
  lastChangedAt: string | null;
}

export default function ParamsClient({ canWrite }: { canWrite: boolean }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<Record<string, number>>({});

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
      width: 200,
      render: (_, r) => (
        <Space>
          <InputNumber
            min={r.min}
            max={r.max}
            value={edits[r.key] ?? r.value}
            disabled={!canWrite}
            onChange={(v) => setEdits((e) => ({ ...e, [r.key]: Number(v) }))}
            addonAfter={r.unit}
            style={{ width: 140 }}
          />
          {r.isDefault ? <Tag>缺省</Tag> : null}
        </Space>
      ),
    },
    {
      title: "",
      width: 90,
      render: (_, r) =>
        canWrite ? (
          <Button size="small" type="primary" disabled={edits[r.key] == null || edits[r.key] === r.value} onClick={() => void save(r)}>
            保存
          </Button>
        ) : null,
    },
    { title: "取值范围", width: 130, render: (_, r) => `${r.min}–${r.max}${r.unit}` },
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
      <Table<Row> rowKey="key" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={false} />
    </div>
  );
}
