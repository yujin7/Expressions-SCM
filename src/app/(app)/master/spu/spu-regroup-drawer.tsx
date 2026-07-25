"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Drawer, Input, Modal, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import RemoteSelect from "@/components/RemoteSelect";
import { fetchJson, postJson } from "@/components/fetchJson";
import { SKU_TYPE_LABELS } from "@/components/labels";

interface MemberRow {
  id: number;
  code: string;
  name: string;
  skuType: string;
  baseUom: string;
  spec: string | null;
  active: boolean;
  needsReview: string[];
}

interface SkuSearchRow {
  id: number;
  code: string;
  name: string;
  spuId: number;
  spuCode: string;
  spuNameCn: string;
  skuType: string;
}

export default function SpuRegroupDrawer({
  spu,
  open,
  onClose,
  canWrite,
}: {
  spu: { id: number; code: string; nameCn: string } | null;
  open: boolean;
  onClose: () => void;
  canWrite: boolean;
}) {
  const { message } = App.useApp();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [candidates, setCandidates] = useState<SkuSearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [moveOut, setMoveOut] = useState<MemberRow | null>(null);
  const [moveOutTarget, setMoveOutTarget] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);

  const loadMembers = useCallback(async () => {
    if (!spu) return;
    setLoading(true);
    try {
      const res = await fetchJson<{ data: MemberRow[]; total: number }>(`/api/master/spu/${spu.id}/skus`);
      setMembers(res.data);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [spu, message]);

  useEffect(() => {
    if (open) void loadMembers();
    if (!open) {
      setMembers([]);
      setCandidates([]);
      setSearchQ("");
      setSelected([]);
    }
  }, [open, loadMembers]);

  const search = async (q: string) => {
    setSearchQ(q);
    if (!q.trim()) {
      setCandidates([]);
      return;
    }
    setSearching(true);
    try {
      const res = await fetchJson<{ data: SkuSearchRow[] }>(
        `/api/master/sku?q=${encodeURIComponent(q.trim())}&page=1&pageSize=50`,
      );
      setCandidates(res.data.filter((r) => r.spuId !== spu?.id));
      setSelected([]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const moveIn = async () => {
    if (!spu || !selected.length) return;
    setSaving(true);
    try {
      const res = await postJson<{ moved: number }>(`/api/master/spu/${spu.id}/regroup`, {
        skuIds: selected,
        mode: "move-in",
      });
      message.success(`已移入 ${res.moved} 个 SKU`);
      setSelected([]);
      await loadMembers();
      await search(searchQ);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const doMoveOut = async () => {
    if (!moveOut || !moveOutTarget) return;
    setSaving(true);
    try {
      await postJson(`/api/master/spu/${moveOutTarget}/regroup`, { skuIds: [moveOut.id], mode: "move-in" });
      message.success(`已将 ${moveOut.code} 移出到目标 SPU`);
      setMoveOut(null);
      setMoveOutTarget(undefined);
      await loadMembers();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const memberColumns: ColumnsType<MemberRow> = [
    {
      title: "SKU",
      dataIndex: "code",
      render: (_, r) => (
        <Space size={4}>
          <span>
            {r.code} {r.name}
            {r.spec ? `（${r.spec}）` : ""}
          </span>
          {r.needsReview.includes("spu") && <Tag color="red">待归组复核</Tag>}
          {!r.active && <Tag>停用</Tag>}
        </Space>
      ),
    },
    { title: "类型", dataIndex: "skuType", width: 80, render: (v: string) => SKU_TYPE_LABELS[v] ?? v },
    { title: "单位", dataIndex: "baseUom", width: 70 },
    ...(canWrite
      ? [
          {
            title: "操作",
            key: "_a",
            width: 100,
            render: (_: unknown, r: MemberRow) => (
              <Button
                type="link"
                size="small"
                onClick={() => {
                  setMoveOut(r);
                  setMoveOutTarget(undefined);
                }}
              >
                移出到…
              </Button>
            ),
          } as ColumnsType<MemberRow>[number],
        ]
      : []),
  ];

  return (
    <Drawer
      title={spu ? `归组管理：${spu.code} ${spu.nameCn}` : "归组管理"}
      width={760}
      open={open}
      onClose={onClose}
      destroyOnHidden
    >
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        当前成员（{members.length}）
      </Typography.Title>
      <Table<MemberRow>
        rowKey="id"
        size="small"
        loading={loading}
        columns={memberColumns}
        dataSource={members}
        pagination={members.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
      />
      {canWrite && (
        <>
          <Typography.Title level={5} style={{ marginTop: 24 }}>
            移入 SKU
          </Typography.Title>
          <Space style={{ marginBottom: 8 }}>
            <Input.Search
              allowClear
              placeholder="按编码/名称搜索其他 SPU 下的 SKU"
              style={{ width: 320 }}
              loading={searching}
              onSearch={(v) => void search(v)}
            />
            <Button type="primary" disabled={!selected.length} loading={saving} onClick={() => void moveIn()}>
              移入本 SPU（{selected.length}）
            </Button>
          </Space>
          <Table<SkuSearchRow>
            rowKey="id"
            size="small"
            loading={searching}
            dataSource={candidates}
            pagination={false}
            rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as number[]) }}
            columns={[
              { title: "SKU", dataIndex: "code", render: (_, r) => `${r.code} ${r.name}` },
              {
                title: "当前所属 SPU",
                dataIndex: "spuCode",
                width: 220,
                render: (_, r) => `${r.spuCode} ${r.spuNameCn}`,
              },
              { title: "类型", dataIndex: "skuType", width: 80, render: (v: string) => SKU_TYPE_LABELS[v] ?? v },
            ]}
            locale={{ emptyText: searchQ ? "无匹配 SKU" : "输入关键字搜索要移入的 SKU" }}
          />
        </>
      )}
      <Modal
        title={moveOut ? `移出 ${moveOut.code} 到其他 SPU` : "移出"}
        open={!!moveOut}
        okText="确认移出"
        cancelText="取消"
        confirmLoading={saving}
        okButtonProps={{ disabled: !moveOutTarget }}
        onCancel={() => setMoveOut(null)}
        onOk={() => void doMoveOut()}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">选择目标 SPU（SKU 将改挂至该 SPU）：</Typography.Paragraph>
        <RemoteSelect
          api="/api/master/spu"
          getLabel={(r) => `${String(r.code)} ${String(r.nameCn)}`}
          filterRow={(r) => r.id !== spu?.id}
          value={moveOutTarget}
          onChange={(v) => setMoveOutTarget(v as number)}
          placeholder="搜索目标 SPU"
          style={{ width: "100%" }}
        />
      </Modal>
    </Drawer>
  );
}
