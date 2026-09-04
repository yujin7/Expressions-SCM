"use client";

/**
 * 运维面板（仅 admin）：db/迁移、任务运行史、连接器运行/检查点、错误留档、导入/导出、
 * 快照数据龄和备份新鲜度。
 * 30s 自动刷新；红色高亮：任务失败 / 24h 错误>0 / 快照龄>3天 / 备份>25h 或缺失说明。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { App, Card, Col, Popconfirm, Row, Space, Spin, Table, Tag, Tooltip, Typography } from "antd";
import { DownloadOutlined, ExportOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { Button } from "antd";
import { fetchJson, postJson } from "@/components/fetchJson";
import type { OpsHealth } from "@/server/modules/admin/health";

/** 任务目录行：已登记任务 ∪ 跑过的任务（后者可能是已下线的历史记录） */
interface JobCatalogRow {
  job: string;
  /** 在当前 INTERVAL_JOBS 目录里 → 可手动触发 */
  registered: boolean;
  last: OpsHealth["lastJobRuns"][number] | null;
}

const CONNECTOR_LABELS: Record<string, string> = { jdy: "简道云", yy: "用友", jst: "聚水潭", feishu: "飞书" };

const SNAPSHOT_RED_DAYS = 3;
const BACKUP_RED_HOURS = 25;

const fmtTime = (iso: string): string => new Date(iso).toLocaleString("zh-CN", { hour12: false });

function fmtAgeHours(hours: number): string {
  if (hours < 0) return "时间异常";
  if (hours < 1) return "1 小时内";
  if (hours < 24) return `${hours.toFixed(1)} 小时前`;
  return `${(hours / 24).toFixed(1)} 天前`;
}

function liveVerificationTag(connector: OpsHealth["connectors"][number]) {
  switch (connector.liveVerificationState) {
    case "valid":
      return <Tag color="green">Live UAT 有效</Tag>;
    case "stale":
      return <Tag color="orange">Live UAT 已过期</Tag>;
    case "missing_evidence":
      return <Tag color="orange">UAT 证据缺失</Tag>;
    case "unbound":
      return <Tag color="red">UAT 未绑定当前目标</Tag>;
    case "future":
    case "invalid":
      return <Tag color="red">UAT 标记无效</Tag>;
    default:
      return <Tag>Live UAT 未验证</Tag>;
  }
}

function securityReviewTag(connector: OpsHealth["connectors"][number]) {
  switch (connector.securityReviewState) {
    case "not_required":
      return null;
    case "valid":
      return <Tag color="green">最小权限复核有效</Tag>;
    case "stale":
      return <Tag color="orange">权限复核已过期</Tag>;
    case "missing_evidence":
      return <Tag color="orange">权限复核证据缺失</Tag>;
    case "unbound":
      return <Tag color="red">权限复核未绑定当前应用</Tag>;
    case "future":
    case "invalid":
      return <Tag color="red">权限复核标记无效</Tag>;
    default:
      return <Tag>最小权限未复核</Tag>;
  }
}

function enablementTag(connector: OpsHealth["connectors"][number]) {
  switch (connector.enablementState) {
    case "enabled":
      return <Tag color="green">同步已启用</Tag>;
    case "disabled":
      return <Tag color="orange">同步未启用</Tag>;
    case "invalid":
      return <Tag color="red">启用标记无效</Tag>;
    default:
      return null;
  }
}

function contractSelectionTag(connector: OpsHealth["connectors"][number]) {
  switch (connector.contractSelectionState) {
    case "selected":
      return <Tag color="green">已选 {connector.selectedContractCount} 条契约</Tag>;
    case "missing":
      return <Tag color="orange">未选同步契约</Tag>;
    case "invalid":
      return <Tag color="red">契约选择无效</Tag>;
    default:
      return null;
  }
}

function identityClearanceTag(connector: OpsHealth["connectors"][number]) {
  switch (connector.identityClearanceState) {
    case "clear":
      return <Tag color="green">身份裁决已清零</Tag>;
    case "blocked":
      return <Tag color="red">身份待裁决 {connector.openScopedAliasExceptions ?? 0}</Tag>;
    case "unknown":
      return <Tag color="orange">尚无身份观察证据</Tag>;
    default:
      return null;
  }
}

export function ConnectorRunState({ row }: { row: OpsHealth["connectorRuns"][number] }) {
  const status = row.status === "failed"
    ? <Tag color="red">失败</Tag>
    : row.status === "running"
      ? <Tag color="processing">运行中</Tag>
      : <Tag color="green">成功</Tag>;
  return (
    <Space wrap size={[4, 4]}>
      {status}
      {row.emptySource ? <Tag color="orange">空观察，旧批次保留</Tag> : null}
      {row.schemaDrift
        ? <Tag color="red">字段结构变化，阻止放行</Tag>
        : row.releaseBlocked ? <Tag color="orange">仅观察，不可放行</Tag> : null}
    </Space>
  );
}

function connectorRuntimeState(rows: OpsHealth["connectorRuns"]) {
  if (rows.length === 0) return <Tag>尚无运行</Tag>;
  const failed = rows.filter((row) => row.status === "failed").length;
  const running = rows.filter((row) => row.status === "running").length;
  const empty = rows.filter((row) => row.emptySource).length;
  const schemaDrift = rows.filter((row) => row.schemaDrift).length;
  const releaseBlocked = rows.filter((row) => row.releaseBlocked && !row.schemaDrift).length;
  return (
    <Space wrap size={[4, 4]}>
      {failed > 0
        ? <Tag color="red">{failed} 条数据流最近失败</Tag>
        : running > 0
          ? <Tag color="processing">{running} 条数据流运行中</Tag>
          : <Tag color="green">{rows.length} 条数据流最近成功</Tag>}
      {empty > 0 ? <Tag color="orange">{empty} 条空观察，旧批次保留</Tag> : null}
      {schemaDrift > 0 ? <Tag color="red">{schemaDrift} 条字段结构变化</Tag> : null}
      {releaseBlocked > 0 ? <Tag color="orange">{releaseBlocked} 条仅观察，不可放行</Tag> : null}
    </Space>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function authPathLabel(path: string): string {
  if (path === "webhook") return "Webhook";
  if (path === "app_bot") return "应用机器人";
  return path;
}

function probeStatusTag(row: OpsHealth["connectorProbes"][number]) {
  if (row.freshness !== "current") return <Tag color="orange">探测证据已过期</Tag>;
  if (row.status === "succeeded") return <Tag color="green">权限探测 {row.passed}/{row.total}</Tag>;
  if (row.status === "skipped") return <Tag>探测未执行</Tag>;
  return <Tag color="red">权限探测 {row.passed}/{row.total}</Tag>;
}

function probeResultTag(result: string, label: string) {
  if (result === "ok") return <Tag key={label} color="green">{label}·已通过</Tag>;
  if (result === "not_checked") return <Tag key={label}>{label}·未探测</Tag>;
  if (result === "missing_configuration") return <Tag key={label}>{label}·缺配置</Tag>;
  if (result === "invalid_configuration") return <Tag key={label} color="red">{label}·配置无效</Tag>;
  if (result === "invalid_actor") return <Tag key={label} color="red">{label}·执行人无效</Tag>;
  if (result === "network_or_timeout") return <Tag key={label} color="orange">{label}·网络/超时</Tag>;
  if (result.startsWith("http_")) return <Tag key={label} color="red">{label}·HTTP {result.slice(5)}</Tag>;
  if (result.startsWith("api_code_")) return <Tag key={label} color="red">{label}·未通过 {result.slice(9)}</Tag>;
  return <Tag key={label} color="red">{label}·响应异常</Tag>;
}

export default function HealthClient() {
  const { message } = App.useApp();
  const [data, setData] = useState<OpsHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestSeq = useRef(0);
  const [runningJob, setRunningJob] = useState<string | null>(null);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const next = await fetchJson<OpsHealth>("/api/admin/health", { signal: controller.signal });
      if (requestSeq.current !== seq || controller.signal.aborted) return;
      setData(next);
      setLoadError(null);
    } catch (e) {
      if (!isAbortError(e) && requestSeq.current === seq) {
        setLoadError((e as Error).message);
        message.error((e as Error).message);
      }
    } finally {
      if (requestSeq.current === seq) {
        setLoading(false);
        if (requestRef.current === controller) requestRef.current = null;
      }
    }
  }, [message]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000); // 30s 自动刷新
    return () => {
      clearInterval(t);
      requestSeq.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
    };
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

  /* 任务目录 = 已登记任务 ∪ 跑过的任务（审计 #10）。
     只列「跑过的」会漏掉最需要手动触发的那批——从没跑成过的任务。 */
  const jobRows: JobCatalogRow[] = (() => {
    const lastByJob = new Map(data.lastJobRuns.map((r) => [r.job, r]));
    const names = [...new Set([...(data.registeredJobs ?? []), ...data.lastJobRuns.map((r) => r.job)])];
    return names.map((job) => ({ job, registered: (data.registeredJobs ?? []).includes(job), last: lastByJob.get(job) ?? null }));
  })();

  const runJob = async (job: string) => {
    setRunningJob(job);
    try {
      const res = await postJson<{ job: string; ok: boolean; message: string; durationMs: number }>(
        `/api/admin/jobs/${encodeURIComponent(job)}/run`,
        {},
      );
      if (res.ok) message.success(`${job} 执行成功（${(res.durationMs / 1000).toFixed(1)}s）`);
      else message.warning(`${job} 未成功：${res.message}`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRunningJob(null);
    }
  };

  const jobColumns: ColumnsType<JobCatalogRow> = [
    { title: "任务", dataIndex: "job" },
    {
      title: "结果",
      width: 110,
      render: (_, row) =>
        row.last == null
          ? <Tag>未运行过</Tag>
          : row.last.ok
            ? <Tag color="green">成功</Tag>
            : <Tag color="red">失败</Tag>,
    },
    { title: "完成时间", width: 170, render: (_, row) => (row.last ? fmtTime(row.last.finishedAt) : "—") },
    {
      title: "摘要",
      ellipsis: true,
      render: (_, row) => <Typography.Text style={{ fontSize: 12 }}>{row.last?.message ?? "—"}</Typography.Text>,
    },
    {
      title: "操作",
      width: 120,
      render: (_, row) =>
        row.registered ? (
          <Popconfirm
            title={`立即运行「${row.job}」？同步类任务可能耗时数分钟，期间不会重复触发。`}
            onConfirm={() => void runJob(row.job)}
          >
            <Button size="small" loading={runningJob === row.job} disabled={runningJob != null}>
              立即运行
            </Button>
          </Popconfirm>
        ) : (
          <Tooltip title="该任务不在当前调度目录里（历史遗留记录），不能手动触发">
            <Typography.Text type="secondary">—</Typography.Text>
          </Tooltip>
        ),
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

  const connectorRunColumns: ColumnsType<OpsHealth["connectorRuns"][number]> = [
    {
      title: "连接器 / 数据流",
      width: 220,
      render: (_, row) => {
        const label = data.connectors.find((connector) => connector.key === row.connector)?.label;
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{label ?? row.connector.toUpperCase()}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.stream}</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: "最近运行",
      width: 170,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <ConnectorRunState row={row} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {fmtTime(row.finishedAt ?? row.startedAt)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "行数（源 / 暂存 / 拒绝）",
      width: 180,
      render: (_, row) => `${row.sourceRows} / ${row.stagedRows} / ${row.rejectedRows}`,
    },
    {
      title: "源时点 / 契约",
      width: 175,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{row.sourceAsOf ?? "未报告源时点"}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.schemaHashPrefix ? `schema ${row.schemaHashPrefix}` : "无 schema hash"}
          </Typography.Text>
          {row.fieldProfile ? (
            <>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {`字段结构 ${row.fieldProfile.fieldCount} · 敏感 ${row.fieldProfile.sensitiveFieldCount}`}
                {row.fieldProfile.truncated ? " · 有界采样" : ""}
              </Typography.Text>
              {row.connector === "yy" || row.connector === "yonyou" ? (
                <Button
                  type="link"
                  size="small"
                  icon={<DownloadOutlined />}
                  href={`/api/admin/health/connector-runs/${row.runId}/field-profile`}
                  style={{ height: "auto", paddingInline: 0, fontSize: 12 }}
                >
                  下载映射评审表
                </Button>
              ) : null}
            </>
          ) : null}
        </Space>
      ),
    },
    {
      title: "别名异常",
      width: 145,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>本次 {row.unresolvedAliases ?? "未报告"}</Typography.Text>
          <Typography.Text type={row.openScopedAliasExceptions > 0 ? "warning" : "secondary"} style={{ fontSize: 12 }}>
            作用域待裁决 {row.openScopedAliasExceptions}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "检查点",
      width: 170,
      render: (_, row) => row.checkpointVersion === null || row.checkpointAgeHours === null ? (
        <Tag>未建立</Tag>
      ) : (
        <Space direction="vertical" size={0}>
          <Typography.Text>v{row.checkpointVersion} · {fmtAgeHours(row.checkpointAgeHours)}</Typography.Text>
          <Typography.Text type={row.checkpointOnLatestRun ? "success" : "secondary"} style={{ fontSize: 12 }}>
            {row.checkpointOnLatestRun ? "已对齐本次成功运行" : "保留上次成功位点"}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "安全摘要",
      dataIndex: "errorSummary",
      width: 210,
      ellipsis: true,
      render: (value: string | null) => value
        ? <Typography.Text type="danger">{value}</Typography.Text>
        : <Typography.Text type="secondary">—</Typography.Text>,
    },
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

      <Card size="small" title={`已登记任务与运行史（${jobRows.length} 个；各任务最近一次）`}>
        <Table
          rowKey="job"
          size="small"
          columns={jobColumns}
          dataSource={jobRows}
          pagination={false}
          scroll={{ x: 1_270 }}
          locale={{ emptyText: "尚无任务运行记录（进程内调度首轮在启动 60 秒后）" }}
        />
        <Typography.Paragraph type="secondary" style={{ margin: "8px 0 0", fontSize: 12 }}>
          手动运行与调度走同一条留痕路径（job_runs），另留一条审计记「是谁按的按钮」；
          同名任务不会并发跑两遍。缺配置/未开开关的任务会返回「未成功」并写明原因——那不是故障，是没配。
        </Typography.Paragraph>
      </Card>

      <Card size="small" title="外部系统连接器（代码、凭据、启用、契约与真实 UAT 分开判定）">
        <Row gutter={[12, 12]}>
          {data.connectors.map((connector) => {
            const connectorRuns = data.connectorRuns.filter((row) => row.connector === connector.key);
            const probe = data.connectorProbes.find((row) => row.connector === connector.key);
            return (
              <Col key={connector.key} xs={24} xl={12}>
                <Card size="small" style={{ height: "100%" }}>
                  <Space direction="vertical" size={10} style={{ width: "100%" }}>
                  <Space wrap size={[4, 4]}>
                    <Typography.Text strong>{connector.label}</Typography.Text>
                    {connector.implementation === "ready"
                      ? <Tag color="green">代码就绪</Tag>
                      : <Tag color="orange">仅契约</Tag>}
                    {connector.configured
                      ? <Tag color="blue">凭据已配</Tag>
                      : <Tag>未配置</Tag>}
                    {enablementTag(connector)}
                    {contractSelectionTag(connector)}
                    {liveVerificationTag(connector)}
                    {securityReviewTag(connector)}
                    {connector.configurationReady
                      ? <Tag color="green">配置 / UAT 就绪</Tag>
                      : <Tag>配置 / UAT 未就绪</Tag>}
                    {identityClearanceTag(connector)}
                    {probe ? probeStatusTag(probe) : null}
                    {connectorRuntimeState(connectorRuns)}
                  </Space>

                  <div>
                    <Typography.Text type="secondary">当前有效能力</Typography.Text>
                    <div style={{ marginTop: 4 }}>
                      {connector.effectiveCapabilities.length > 0
                        ? connector.effectiveCapabilities.map((value) => (
                            <Tag key={value} style={{ marginBottom: 4 }}>{value}</Tag>
                          ))
                        : <Typography.Text type="secondary">尚无可用鉴权路径</Typography.Text>}
                    </div>
                  </div>

                  {connector.configuredAuthPaths.length > 0 ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      当前发送路径：{connector.activeAuthPath
                        ? authPathLabel(connector.activeAuthPath)
                        : "无"}
                      {connector.configuredAuthPaths.length > 1
                        ? ` · 已配置：${connector.configuredAuthPaths.map(authPathLabel).join(" + ")}`
                        : ""}
                    </Typography.Text>
                  ) : null}

                  <div>
                    <Typography.Text type="secondary">缺失配置</Typography.Text>
                    <div style={{ marginTop: 4 }}>
                      {connector.missingEnv.length === 0 ? (
                        <Typography.Text type="success">无</Typography.Text>
                      ) : (
                        <Space wrap size={[4, 4]}>
                          {connector.missingEnv.map((value) => (
                            <Typography.Text key={value} code>{value}</Typography.Text>
                          ))}
                        </Space>
                      )}
                    </div>
                  </div>

                  <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                    {connector.blocker ?? "—"}
                  </Typography.Paragraph>
                  <div>
                    <Space style={{ justifyContent: "space-between", width: "100%", marginBottom: 4 }}>
                      <Typography.Text strong>解锁步骤</Typography.Text>
                      {connector.managementUrl ? (
                        <Button
                          type="link"
                          size="small"
                          icon={<ExportOutlined />}
                          href={connector.managementUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          打开官方后台
                        </Button>
                      ) : null}
                    </Space>
                    <ol style={{ margin: 0, paddingInlineStart: 22 }}>
                      {connector.remediationSteps.map((step) => (
                        <li key={step} style={{ marginBottom: 4 }}>
                          <Typography.Text style={{ fontSize: 12 }}>{step}</Typography.Text>
                        </li>
                      ))}
                    </ol>
                  </div>
                  {connector.liveVerifiedAt ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      验证时间：{fmtTime(connector.liveVerifiedAt)}
                      {connector.liveVerificationRef
                        ? ` · 证据：${connector.liveVerificationRef}`
                        : " · 缺少非秘密证据编号"}
                      {` · ${connector.liveVerificationMaxAgeDays} 天内有效`}
                    </Typography.Text>
                  ) : null}
                  {connector.securityReviewedAt ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      权限复核：{fmtTime(connector.securityReviewedAt)}
                      {connector.securityReviewRef
                        ? ` · 证据：${connector.securityReviewRef}`
                        : " · 缺少非秘密证据编号"}
                      {` · ${connector.securityReviewMaxAgeDays} 天内有效`}
                    </Typography.Text>
                  ) : null}
                  {connector.expectedLiveVerificationBinding
                    || connector.expectedSecurityReviewBinding ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {connector.expectedLiveVerificationBinding
                          ? `UAT 绑定：${connector.expectedLiveVerificationBinding}`
                          : ""}
                        {connector.expectedLiveVerificationBinding
                          && connector.expectedSecurityReviewBinding ? " · " : ""}
                        {connector.expectedSecurityReviewBinding
                          ? `权限复核绑定：${connector.expectedSecurityReviewBinding}`
                          : ""}
                      </Typography.Text>
                    ) : null}
                  </Space>
                </Card>
              </Col>
            );
          })}
        </Row>
      </Card>

      <Card size="small" title="契约就绪：同步了 ≠ 有人读">
        <Table
          rowKey={(row) => `${row.connector}:${row.key}`}
          size="small"
          pagination={false}
          scroll={{ x: 1_000 }}
          dataSource={data.contractConsumers ?? []}
          locale={{ emptyText: "尚未登记契约消费者" }}
          columns={[
            {
              title: "系统",
              dataIndex: "connector",
              width: 100,
              render: (v: string) => CONNECTOR_LABELS[v] ?? v.toUpperCase(),
            },
            {
              title: "契约 / 数据流",
              width: 260,
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text type={row.consumers.length === 0 ? "secondary" : undefined}>{row.label}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }} code>{row.key}</Typography.Text>
                </Space>
              ),
            },
            {
              title: "下游读模型",
              render: (_, row) =>
                row.consumers.length === 0 ? (
                  <Tooltip title="同步照常跑、staging 照常长，但没有任何读模型消费它：占三方配额、占存储，对业务零产出。要么接上消费者，要么停掉这条契约。">
                    <Tag>无消费者</Tag>
                  </Tooltip>
                ) : (
                  <Space wrap size={[4, 4]}>
                    {row.consumers.map((c) => <Tag key={c} color="blue">{c}</Tag>)}
                  </Space>
                ),
            },
            {
              title: "读模型数",
              width: 100,
              align: "right",
              render: (_, row) =>
                row.consumers.length === 0
                  ? <Typography.Text type="secondary">0</Typography.Text>
                  : row.consumers.length,
            },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ margin: "8px 0 0", fontSize: 12 }}>
          「已选 N 条契约」只说明拉数配置齐了，不说明数据有人读。灰行 = 同步得好好的、下游没有任何读模型消费
          （当前 {(data.contractConsumers ?? []).filter((c) => c.consumers.length === 0).length} 条）。
          本列由 `integrations/contract-consumers.ts` 静态登记，架构门用 grep 逐条比对真实引用，登记漂移即红。
        </Typography.Paragraph>
      </Card>

      <Card size="small" title="连接器只读权限探测（实时 API，不写业务数据）">
        <Table
          rowKey="connector"
          size="small"
          tableLayout="fixed"
          pagination={false}
          dataSource={data.connectorProbes}
          scroll={{ x: 1_100 }}
          locale={{ emptyText: "尚无已留痕的权限探测；可在上方「已登记任务」里手动运行 probe-jst-permissions / probe-yonyou-permissions" }}
          columns={[
            {
              title: "系统",
              width: 110,
              render: (_, row) => data.connectors.find((connector) => connector.key === row.connector)?.label
                ?? row.connector.toUpperCase(),
            },
            {
              title: "结果",
              width: 150,
              render: (_, row) => probeStatusTag(row),
            },
            {
              title: "鉴权 / 目标绑定",
              width: 190,
              render: (_, row) => (
                <Space wrap size={[4, 4]}>
                  <Tag color={row.authentication === "validated" ? "green" : row.authentication === "not_checked" ? "default" : "red"}>
                    {row.authentication === "validated" ? "签名鉴权已通过" : row.authentication === "not_checked" ? "未鉴权" : "鉴权未通过"}
                  </Tag>
                  <Tag color={row.bindingMatches ? "green" : "red"}>
                    {row.bindingMatches ? "当前目标已绑定" : "目标绑定不一致"}
                  </Tag>
                </Space>
              ),
            },
            {
              title: "逐项只读权限",
              render: (_, row) => (
                <Space wrap size={[4, 4]}>
                  {row.checks.map((check) => probeResultTag(check.result, check.label))}
                </Space>
              ),
            },
            {
              title: "留痕时间",
              width: 170,
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text>{fmtTime(row.checkedAt)}</Typography.Text>
                  <Typography.Text type={row.freshness === "current" ? "secondary" : "warning"} style={{ fontSize: 12 }}>
                    {row.ageHours === null ? "时间无效" : row.freshness === "current" ? fmtAgeHours(row.ageHours) : `${fmtAgeHours(row.ageHours)}·已过期`}
                  </Typography.Text>
                </Space>
              ),
            },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ margin: "8px 0 0" }}>
          探测只证明当前凭据在当前目标上可读；不代替 SKU/供应商身份映射、控制总量、失败重放、连续 7 天恢复演练和业务 UAT。
        </Typography.Paragraph>
      </Card>

      <Card size="small" title="连接器最近运行与检查点">
        <Table
          rowKey={(row) => `${row.connector}:${row.stream}`}
          size="small"
          tableLayout="fixed"
          columns={connectorRunColumns}
          dataSource={data.connectorRuns}
          pagination={false}
          scroll={{ x: 1_270 }}
          locale={{ emptyText: "尚无连接器运行记录" }}
        />
      </Card>

      <Card size="small" title={`最近错误（${data.recentErrors.length} 条 / 24h 共 ${data.errorCount24h} 条）`}>
        <Table
          rowKey="id"
          size="small"
          columns={errColumns}
          dataSource={data.recentErrors}
          pagination={false}
          scroll={{ x: "max-content" }}
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
              scroll={{ x: "max-content" }}
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
              scroll={{ x: "max-content" }}
              locale={{ emptyText: "无快照仓" }}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
