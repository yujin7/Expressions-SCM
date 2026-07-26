"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Col, Descriptions, Drawer, Row, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import { BOM_STATUS_COLORS, BOM_STATUS_LABELS } from "@/components/labels";

interface DiffSide {
  id: number;
  versionNo: string;
  status: string;
  effectiveDate: string | null;
  lineCount: number;
}

interface DiffSnap {
  qtyPer: string;
  uom: string;
  supplierId: number | null;
  supplierName: string | null;
}

interface DiffLine {
  materialSkuId: number;
  materialSkuCode: string;
  materialName: string | null;
  kind: "added" | "removed" | "changed" | "unchanged";
  changes: ("qty" | "supplier" | "uom")[];
  base: DiffSnap | null;
  target: DiffSnap | null;
}

interface DiffResult {
  product: { skuId: number; code: string; name: string; spec: string | null };
  target: DiffSide;
  base: DiffSide | null;
  siblings: { id: number; versionNo: string; status: string; effectiveDate: string | null }[];
  lines: DiffLine[];
}

const KIND_LABELS: Record<DiffLine["kind"], { text: string; color: string }> = {
  added: { text: "新增", color: "green" },
  removed: { text: "删除", color: "red" },
  changed: { text: "变更", color: "orange" },
  unchanged: { text: "不变", color: "default" },
};

function SideCard({ title, side }: { title: string; side: DiffSide | null }) {
  return (
    <Descriptions
      size="small"
      column={1}
      title={title}
      bordered
      items={
        side
          ? [
              { key: "v", label: "版本", children: side.versionNo },
              {
                key: "s",
                label: "状态",
                children: <Tag color={BOM_STATUS_COLORS[side.status]}>{BOM_STATUS_LABELS[side.status] ?? side.status}</Tag>,
              },
              { key: "d", label: "生效日期", children: side.effectiveDate ?? "—" },
              { key: "n", label: "物料行数", children: side.lineCount },
            ]
          : [{ key: "none", label: "版本", children: "—" }]
      }
    />
  );
}

/** 变化值渲染：旧 → 新（量变=orange） */
function delta(oldV: string | null | undefined, newV: string | null | undefined, changed: boolean) {
  if (!changed) return <span>{newV ?? oldV ?? "—"}</span>;
  return (
    <span style={{ color: "#d46b08" }}>
      {oldV ?? "—"} → {newV ?? "—"}
    </span>
  );
}

export default function BomDiffDrawer({
  bomId,
  title,
  open,
  onClose,
}: {
  bomId: number | null;
  title: string;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [againstId, setAgainstId] = useState<number | undefined>(undefined);

  const load = useCallback(async () => {
    if (bomId == null) return;
    setLoading(true);
    try {
      const url = `/api/master/bom/${bomId}/diff${againstId != null ? `?againstId=${againstId}` : ""}`;
      setDiff(await fetchJson<DiffResult>(url));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [bomId, againstId, message]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) {
      setDiff(null);
      setAgainstId(undefined);
    }
  }, [open]);

  const columns: ColumnsType<DiffLine> = [
    {
      title: "物料 SKU",
      dataIndex: "materialSkuCode",
      render: (_, l) => `${l.materialSkuCode} ${l.materialName ?? ""}`,
    },
    {
      title: "差异",
      dataIndex: "kind",
      width: 150,
      render: (_, l) => (
        <Space size={4} wrap>
          <Tag color={KIND_LABELS[l.kind].color}>{KIND_LABELS[l.kind].text}</Tag>
          {l.changes.includes("qty") && <Tag color="orange">量变</Tag>}
          {l.changes.includes("supplier") && <Tag color="blue">供应商</Tag>}
          {l.changes.includes("uom") && <Tag color="purple">单位</Tag>}
        </Space>
      ),
    },
    {
      title: "单位用量",
      key: "qty",
      width: 160,
      render: (_, l) => delta(l.base?.qtyPer, l.target?.qtyPer, l.changes.includes("qty")),
    },
    {
      title: "单位",
      key: "uom",
      width: 120,
      render: (_, l) => delta(l.base?.uom, l.target?.uom, l.changes.includes("uom")),
    },
    {
      title: "指定供应商",
      key: "supplier",
      width: 200,
      render: (_, l) =>
        delta(l.base?.supplierName ?? (l.base ? "—" : null), l.target?.supplierName ?? (l.target ? "—" : null), l.changes.includes("supplier")),
    },
  ];

  return (
    <Drawer title={`版本对比：${title}`} width={880} open={open} onClose={onClose} destroyOnHidden>
      {diff && (
        <>
          <Space style={{ marginBottom: 12 }}>
            <span>对比基准：</span>
            <Select
              style={{ width: 260 }}
              placeholder="默认：上一版本"
              value={diff.base?.id}
              onChange={(v) => setAgainstId(v)}
              options={diff.siblings
                .filter((s) => s.id !== diff.target.id)
                .map((s) => ({
                  value: s.id,
                  label: `${s.versionNo}（${BOM_STATUS_LABELS[s.status] ?? s.status}${s.effectiveDate ? ` · ${s.effectiveDate}` : ""}）`,
                }))}
            />
          </Space>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={12}>
              <SideCard title="基准版本" side={diff.base} />
            </Col>
            <Col span={12}>
              <SideCard title="当前版本" side={diff.target} />
            </Col>
          </Row>
          {!diff.base ? (
            <Alert type="info" showIcon message="该成品没有其他版本可对比（这是首个 BOM 版本）" />
          ) : (
            <>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                共 {diff.lines.length} 行：新增 {diff.lines.filter((l) => l.kind === "added").length} · 删除{" "}
                {diff.lines.filter((l) => l.kind === "removed").length} · 变更{" "}
                {diff.lines.filter((l) => l.kind === "changed").length}
              </Typography.Paragraph>
              <Table<DiffLine>
                rowKey="materialSkuId"
                size="small"
                loading={loading}
                columns={columns}
                dataSource={diff.lines}
                pagination={false}
                rowClassName={(l) => (l.kind === "unchanged" ? "" : "bom-diff-changed")}
              />
            </>
          )}
        </>
      )}
      {!diff && loading && <Typography.Text type="secondary">加载中…</Typography.Text>}
    </Drawer>
  );
}
