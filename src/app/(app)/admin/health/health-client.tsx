"use client";

/**
 * 运维面板（仅 admin）：db/迁移、任务运行史、错误留档、导入/导出、快照数据龄、备份新鲜度。
 * 30s 自动刷新；红色高亮：任务失败 / 24h 错误>0 / 快照龄>3天 / 备份>25h 或缺失说明。
 */
import { useCallback, useEffect, useState } from "react";
import { App, Card, Col, Row, Space, Spin, Table, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { Button } from "antd";
import { fetchJson } from "@/components/fetchJson";
import type { OpsHealth } from "@/server/modules/admin/health";

const SNAPSHOT_RED_DAYS = 3;
const BACKUP_RED_HOURS = 25;

const fmtTime = (iso: string): string => new Date(iso).toLocaleString("zh-CN", { hour12: false });

export default function HealthClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<OpsHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchJson<OpsHealth>("/api/admin/health"));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000); // 30s 自动刷新
    return () => clearInterval(t);
  }, [load]);

  if (!data) {
    return (
      <div style={{ textAlign: "center", padding: 48 }}>
        {loadError ? (
          <Space direction="vertical">
            <Typography.Text type="danger">运维数据加载失败：{loadError}</Typography.Text>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              重试
            </Button>
          </Space>
        ) : (
          <Spin />
        )}
      </div>
    );
  }

  const { migrations, backupFreshness } = data;
  const dbBad = !data.dbOk || migrations.drift;
  const jobBad = data.lastJobRuns.some((r) => !r.ok);
  const errBad = data.errorCount24h > 0;
  const snapBad = data.snapshotAges.some((r) => r.ageDays === null || r.ageDays > SNAPSHOT_RED_DAYS);
  const backupBad = backupFreshness !== null && backupFreshness.ageHours > BACKUP_RED_HOURS;

  const statusCard = (title: string, ok: boolean, body: React.ReactNode) => (
    <Card size="small" style={ok ? undefined : { borderColor: "#ff4d4f", background: "#fff2f0" }}>
      <Typography.Text type="secondary">{title}</Typography.Text>
      <div style={{ fontSize: 16, marginTop: 4 }}>{body}</div>
    </Card>
  );

  const jobColumns: ColumnsType<OpsHealth["lastJobRuns"][number]> = [
    { title: "任务", dataIndex: "job" },
    {
      title: "结果",
      dataIndex: "ok",
      width: 80,
      render: (ok: boolean) => (ok ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>),
    },
    { title: "完成时间", dataIndex: "finishedAt", width: 170, render: fmtTime },
    {
      title: "摘要",
      dataIndex: "message",
      ellipsis: true,
      render: (v: string | null) => <Typography.Text style={{ fontSize: 12 }}>{v ?? "—"}</Typography.Text>,
    },
  ];

  const errColumns: ColumnsType<OpsHealth["recentErrors"][number]> = [
    { title: "错误码", dataIndex: "errorId", width: 100, render: (v: string) => <Tag color="red">{v}</Tag> },
    { title: "路径", dataIndex: "path", width: 200, render: (v: string | null) => v ?? "—" },
    { title: "信息", dataIndex: "message", ellipsis: true },
    { title: "时间", dataIndex: "createdAt", width: 170, render: fmtTime },
  ];

  const importColumns: ColumnsType<OpsHealth["recentImports"][number]> = [
    { title: "#", dataIndex: "id", width: 60 },
    { title: "模板", dataIndex: "template", width: 140 },
    { title: "文件", dataIndex: "filename", ellipsis: true },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (v: string) =>
        v === "failed" ? <Tag color="red">{v}</Tag> : v === "done" ? <Tag color="green">{v}</Tag> : <Tag>{v}</Tag>,
    },
    { title: "成功/失败行", width: 110, render: (_, r) => `${r.okRows} / ${r.failRows}` },
    { title: "时间", dataIndex: "createdAt", width: 170, render: fmtTime },
  ];

  const snapColumns: ColumnsType<OpsHealth["snapshotAges"][number]> = [
    { title: "仓库", render: (_, r) => `${r.code} ${r.name}` },
    { title: "最新快照", dataIndex: "latestBizDate", width: 120, render: (v: string | null) => v ?? "从未导入" },
    {
      title: "数据龄（天）",
      dataIndex: "ageDays",
      width: 120,
      render: (v: number | null) =>
        v === null || v > SNAPSHOT_RED_DAYS ? <Tag color="red">{v ?? "∞"}</Tag> : <Tag color="green">{v}</Tag>,
    },
  ];
  const connectorColumns: ColumnsType<OpsHealth["connectors"][number]> = [
    { title: "系统", dataIndex: "label", width: 180 },
    {
      title: "实现",
      dataIndex: "implementation",
      width: 110,
      render: (value: string) => value === "ready"
        ? <Tag color="green">已接通</Tag>
        : <Tag color="orange">仅契约</Tag>,
    },
    {
      title: "配置",
      dataIndex: "configured",
      width: 100,
      render: (value: boolean) => value ? <Tag color="blue">凭据已配</Tag> : <Tag>未配置</Tag>,
    },
    {
      title: "可运行",
      dataIndex: "operational",
      width: 100,
      render: (value: boolean) => value ? <Tag color="green">是</Tag> : <Tag color="red">否</Tag>,
    },
    { title: "阻塞/说明", dataIndex: "blocker", render: (value: string | null) => value ?? "—" },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Space style={{ justifyContent: "space-between", width: "100%" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          运维面板
        </Typography.Title>
        <Space>
          <Typography.Text type="secondary">
            数据时间 {fmtTime(data.generatedAt)}（每 30 秒自动刷新）
          </Typography.Text>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
      </Space>

      <Row gutter={[12, 12]}>
        <Col xs={24} sm={12} md={8} lg={4}>
          {statusCard("数据库 / 迁移", !dbBad, dbBad ? (
            <Tag color="red">{!data.dbOk ? "DB 不可用" : "schema 漂移"}</Tag>
          ) : (
            <span>
              正常{" "}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {migrations.applied === -2 ? `${migrations.files} 个迁移（PG 模式）` : `${migrations.applied}/${migrations.files} 已应用`}
              </Typography.Text>
            </span>
          ))}
        </Col>
        <Col xs={24} sm={12} md={8} lg={4}>
          {statusCard("定时任务", !jobBad, jobBad ? <Tag color="red">有失败</Tag> : `${data.lastJobRuns.length} 个任务正常`)}
        </Col>
        <Col xs={24} sm={12} md={8} lg={4}>
          {statusCard("24h 错误", !errBad, errBad ? <Tag color="red">{data.errorCount24h} 条</Tag> : "0 条")}
        </Col>
        <Col xs={24} sm={12} md={8} lg={4}>
          {statusCard(
            "导出队列",
            true,
            `待处理 ${data.exportQueue.pending} / 进行中 ${data.exportQueue.running}`,
          )}
        </Col>
        <Col xs={24} sm={12} md={8} lg={4}>
          {statusCard("快照数据龄", !snapBad, snapBad ? <Tag color="red">超 {SNAPSHOT_RED_DAYS} 天</Tag> : "正常")}
        </Col>
        <Col xs={24} sm={12} md={8} lg={4}>
          {statusCard(
            "备份新鲜度",
            !backupBad,
            backupFreshness === null ? (
              <Typography.Text type="secondary">无备份目录（开发环境正常）</Typography.Text>
            ) : backupBad ? (
              <Tag color="red">{backupFreshness.ageHours}h 前</Tag>
            ) : (
              `${backupFreshness.ageHours}h 前（${backupFreshness.file}）`
            ),
          )}
        </Col>
      </Row>

      <Card size="small" title="任务运行史（各任务最近一次）">
        <Table
          rowKey="job"
          size="small"
          columns={jobColumns}
          dataSource={data.lastJobRuns}
          pagination={false}
          locale={{ emptyText: "尚无任务运行记录（进程内调度首轮在启动 60 秒后）" }}
        />
      </Card>

      <Card size="small" title="外部系统连接器（实现与凭据分开判定）">
        <Table
          rowKey="key"
          size="small"
          columns={connectorColumns}
          dataSource={data.connectors}
          pagination={false}
        />
      </Card>

      <Card size="small" title={`最近错误（${data.recentErrors.length} 条 / 24h 共 ${data.errorCount24h} 条）`}>
        <Table
          rowKey="id"
          size="small"
          columns={errColumns}
          dataSource={data.recentErrors}
          pagination={false}
          locale={{ emptyText: "无运行错误" }}
        />
      </Card>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={14}>
          <Card size="small" title="最近导入任务">
            <Table
              rowKey="id"
              size="small"
              columns={importColumns}
              dataSource={data.recentImports}
              pagination={false}
              locale={{ emptyText: "无导入记录" }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card size="small" title="快照仓数据龄">
            <Table
              rowKey="warehouseId"
              size="small"
              columns={snapColumns}
              dataSource={data.snapshotAges}
              pagination={false}
              locale={{ emptyText: "无快照仓" }}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
