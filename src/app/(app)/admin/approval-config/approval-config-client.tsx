"use client";

/**
 * 审批节点配置：单据类型 → 审批角色。
 *
 * 此前这张映射表只能靠改种子代码重跑来调整——业务想把某类单据的审批人换个角色，
 * 得走一次发布。这里补上自助入口，但保持三条约束：仅管理员、不接受 admin
 * 作为审批角色（它本就全域可审）、每次改动逐条写审计。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson, putJson } from "@/components/fetchJson";
import { ROLE_LABELS } from "@/server/core/constants";

interface Row {
  docType: string;
  docTypeLabel: string;
  approverRole: string;
  approverRoleLabel: string;
}

export default function ApprovalConfigClient() {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [assignable, setAssignable] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchJson<{ rows: Row[]; assignableRoles: string[] }>("/api/admin/approval-config");
      setRows(d.rows);
      setAssignable(d.assignableRoles);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { void load(); }, [load]);

  const apply = async (row: Row, next: string) => {
    setSavingKey(row.docType);
    try {
      await putJson("/api/admin/approval-config", { docType: row.docType, approverRole: next });
      message.success(`「${row.docTypeLabel}」审批角色已改为 ${ROLE_LABELS[next as keyof typeof ROLE_LABELS] ?? next}`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSavingKey(null);
    }
  };

  const columns: ColumnsType<Row> = [
    { title: "审批域", dataIndex: "docTypeLabel", width: 160 },
    { title: "标识", dataIndex: "docType", width: 130, render: (v: string) => <Tag>{v}</Tag> },
    {
      title: "审批角色",
      dataIndex: "approverRole",
      width: 220,
      render: (v: string, r) => (
        <Select
          value={v}
          style={{ width: 180 }}
          loading={savingKey === r.docType}
          disabled={savingKey != null}
          options={assignable.map((role) => ({ value: role, label: ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role }))}
          onChange={(next) => {
            if (next === v) return;
            modal.confirm({
              title: `把「${r.docTypeLabel}」的审批角色改为「${ROLE_LABELS[next as keyof typeof ROLE_LABELS] ?? next}」？`,
              content:
                "这会立即改变谁有权批准该类单据。已提交待审的单据也按新角色判定；"
                + "本次变更会记入审计。",
              okText: "确认修改",
              cancelText: "取消",
              onOk: () => apply(r, next),
            });
          }}
        />
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>审批节点配置</Typography.Title>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Alert
          type="warning"
          showIcon
          message="这是审批权限的单一权威"
          description={
            <>
              改这里等于改「谁有权批准」。审批人还必须同时满足两个条件：属于该角色、
              且账号已勾选「审批人」；<b>制单人永远不能审批自己的单据</b>（职责分离，系统强制，管理员也不豁免）。
              管理员本就全域可审，因此不作为可选项。每次修改逐条写审计。
            </>
          }
        />
        <Table<Row>
          rowKey="docType"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={false}
        />
      </Space>
    </div>
  );
}
