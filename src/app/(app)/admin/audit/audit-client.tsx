"use client";

/**
 * 审计日志查看（UAT 缺口 #2）：筛选（对象/单据ID/操作人/动作/时间段/关键字）+
 * 展开行左右并排展示 before/after JSON。仅追加数据，无任何写操作。
 * 操作人筛选：admin 用 /api/admin/users 下拉；finance 无用户管理权限→填用户 ID。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  App, Button, Col, DatePicker, Input, InputNumber, Row, Select, Space, Table, Tag, Typography,
} from "antd";
import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import { fetchJson } from "@/components/fetchJson";
import type { AuditRow } from "@/server/modules/admin/audit";

/** 常见审计对象 → 中文（未知值原样展示） */
const ENTITY_LABELS: Record<string, string> = {
  user: "用户",
  sku: "SKU",
  spu: "产品",
  category: "品类",
  supplier: "供应商",
  warehouse: "仓库",
  bom: "BOM",
  bh: "备货申请单",
  wo: "委外工单",
  po: "采购订单",
  pc: "价格变更单",
  jg: "加工通知单",
  fl: "发料单",
  tl: "退料单",
  sh: "收货单",
  ct: "采购退货单",
  js: "结算单",
  stock_doc: "库存单据",
  import_job: "导入任务",
  export_job: "导出任务",
  review_item: "复核事项",
};

/** 常见动作 → 中文 */
const ACTION_LABELS: Record<string, string> = {
  create: "创建",
  update: "修改",
  submit: "提交",
  approve: "审批通过",
  reject: "驳回",
  reverse: "红字冲销",
  activate: "启用",
  confirm: "确认",
  generate: "生成",
  qc: "质检",
  inbound: "入库",
  change_password: "修改密码",
  login_locked: "登录锁定",
  claim: "认领",
  ignore: "忽略",
};

const SH_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : SH_FMT.format(d);
}

function JsonPane({ title, value }: { title: string; value: unknown }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <Typography.Text type="secondary">{title}</Typography.Text>
      <pre
        style={{
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 6,
          padding: 8,
          margin: "4px 0 0",
          maxHeight: 320,
          overflow: "auto",
          fontSize: 12,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {value == null ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

interface UserOption {
  id: number;
  name: string;
  username: string | null;
}

export default function AuditClient({ isAdmin }: { isAdmin: boolean }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [entities, setEntities] = useState<string[]>([]);
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);

  // 筛选条件
  const [entity, setEntity] = useState<string | undefined>();
  const [entityId, setEntityId] = useState<number | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [action, setAction] = useState<string | undefined>();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(
    async (p = page, ps = pageSize) => {
      setLoading(true);
      try {
        const sp = new URLSearchParams();
        sp.set("page", String(p));
        sp.set("pageSize", String(ps));
        if (entity) sp.set("entity", entity);
        if (entityId) sp.set("entityId", String(entityId));
        if (userId) sp.set("userId", String(userId));
        if (action) sp.set("action", action);
        if (range?.[0]) sp.set("from", range[0].format("YYYY-MM-DD"));
        if (range?.[1]) sp.set("to", range[1].format("YYYY-MM-DD"));
        if (q.trim()) sp.set("q", q.trim());
        const res = await fetchJson<{ rows: AuditRow[]; total: number }>(`/api/admin/audit?${sp}`);
        setRows(res.rows);
        setTotal(res.total);
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [page, pageSize, entity, entityId, userId, action, range, q, message],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);

  useEffect(() => {
    void fetchJson<{ entities: string[] }>("/api/admin/audit/entities")
      .then((r) => setEntities(r.entities))
      .catch(() => setEntities([]));
    if (isAdmin) {
      void fetchJson<{ rows: UserOption[] }>("/api/admin/users")
        .then((r) => setUserOptions(r.rows))
        .catch(() => setUserOptions([]));
    }
  }, [isAdmin]);

  const search = () => {
    setPage(1);
    void load(1, pageSize);
  };

  const entityOptions = useMemo(
    () =>
      entities.map((e) => ({
        value: e,
        label: ENTITY_LABELS[e] ? `${ENTITY_LABELS[e]}（${e}）` : e,
      })),
    [entities],
  );

  const actionOptions = useMemo(
    () => Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label: `${label}（${value}）` })),
    [],
  );

  const columns: ColumnsType<AuditRow> = [
    { title: "ID", dataIndex: "id", width: 80 },
    { title: "时间", dataIndex: "createdAt", width: 170, render: (v: string) => fmtTime(v) },
    {
      title: "操作人",
      dataIndex: "userName",
      width: 130,
      render: (v: string | null, r) => (v ? `${v}（#${r.userId}）` : `#${r.userId}`),
    },
    {
      title: "对象",
      dataIndex: "entity",
      width: 140,
      render: (v: string) => <Tag>{ENTITY_LABELS[v] ?? v}</Tag>,
    },
    { title: "对象ID", dataIndex: "entityId", width: 90, render: (v: number | null) => v ?? "—" },
    {
      title: "动作",
      dataIndex: "action",
      width: 130,
      render: (v: string) => ACTION_LABELS[v] ?? v,
    },
    {
      title: "变更摘要",
      render: (_, r) => {
        const has = (x: unknown) => x != null;
        if (has(r.before) && has(r.after)) return "前后对照（展开查看）";
        if (has(r.after)) return "新值（展开查看）";
        if (has(r.before)) return "旧值（展开查看）";
        return "—";
      },
    },
  ];

  return (
    <div>
      <Space style={{ justifyContent: "space-between", width: "100%", marginBottom: 12 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          审计日志
        </Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>

      <Row gutter={[8, 8]} style={{ marginBottom: 12 }}>
        <Col>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="对象类型"
            style={{ width: 200 }}
            options={entityOptions}
            value={entity}
            onChange={setEntity}
          />
        </Col>
        <Col>
          <InputNumber placeholder="对象ID" style={{ width: 110 }} min={1} value={entityId} onChange={setEntityId} />
        </Col>
        <Col>
          {isAdmin ? (
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="操作人"
              style={{ width: 180 }}
              options={userOptions.map((u) => ({ value: u.id, label: `${u.name}（${u.username ?? u.id}）` }))}
              value={userId}
              onChange={(v) => setUserId(v ?? null)}
            />
          ) : (
            <InputNumber placeholder="操作人用户ID" style={{ width: 140 }} min={1} value={userId} onChange={setUserId} />
          )}
        </Col>
        <Col>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="动作"
            style={{ width: 180 }}
            options={actionOptions}
            value={action}
            onChange={setAction}
          />
        </Col>
        <Col>
          <DatePicker.RangePicker value={range} onChange={(v) => setRange(v)} allowEmpty={[true, true]} />
        </Col>
        <Col>
          <Input
            placeholder="对象/动作关键字"
            style={{ width: 160 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onPressEnter={search}
            allowClear
          />
        </Col>
        <Col>
          <Button type="primary" icon={<SearchOutlined />} onClick={search}>
            查询
          </Button>
        </Col>
      </Row>

      <Table<AuditRow>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={loading}
        expandable={{
          rowExpandable: (r) => r.before != null || r.after != null,
          expandedRowRender: (r) => (
            <div style={{ display: "flex", gap: 12 }}>
              <JsonPane title="变更前（before）" value={r.before} />
              <JsonPane title="变更后（after）" value={r.after} />
            </div>
          ),
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />
    </div>
  );
}
