"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowRightOutlined, DownloadOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  capabilityReadiness,
  DECISION_CAPABILITIES,
  type CapabilityReadiness,
} from "@/components/decision-capabilities";
import {
  DATA_PRODUCTS,
  DATA_PRODUCT_AUTOMATION_LABEL,
  DATA_PRODUCT_AUTHORITY_LABEL,
  DATA_PRODUCT_CADENCE_LABEL,
  DATA_PRODUCT_SOURCE_LABEL,
  dataProductStreamLabel,
  type DataProductAuthority,
  type DataProductDefinition,
} from "@/components/data-products";
import {
  currentProductAutomation,
  evaluateProductSourceEvidence,
  evaluateProductSupportingEvidence,
  type ProductEvidenceSummary,
  type ProductStreamEvidence,
} from "@/components/data-product-source-evidence";
import { metric, metricTooltip } from "@/components/metrics";
import { postJson, putJson } from "@/components/fetchJson";
import type {
  DataSourceReadiness,
  DataSourceState,
} from "@/server/modules/report/data-source-readiness";
import type {
  DataProductReleaseReadiness,
  ReleasedAutomationLevel,
} from "@/server/modules/report/data-product-release";
import type { DataProductOutcomeReadiness } from "@/server/modules/report/data-product-outcome";
import type { JiandaoyunSupportingObservation } from "@/server/modules/report/jiandaoyun-supporting-observation";
import DataProductOutcomeControl from "@/components/DataProductOutcomeControl";
import DataAssetDecisionCoverage from "@/components/DataAssetDecisionCoverage";
import {
  buildDataProductWorkQueue,
  type DataProductWorkStage,
} from "@/components/data-product-work-queue";
import { buildDataProductEvidenceExport } from "@/components/data-product-evidence-export";
import { exportCsv } from "@/components/exportCsv";

const STATE_META: Record<CapabilityReadiness, { label: string; color: string; stroke: string }> = {
  ready: { label: "当前可用", color: "success", stroke: "#16a34a" },
  partial: { label: "部分可用", color: "warning", stroke: "#d97706" },
  blocked: { label: "尚未解锁", color: "error", stroke: "#dc2626" },
};

const SOURCE_STATE_META: Record<DataSourceState, { label: string; color: string }> = {
  operational: { label: "已放行", color: "success" },
  observation: { label: "仅观察", color: "warning" },
  contract_only: { label: "仅契约", color: "default" },
  blocked: { label: "未接入", color: "error" },
};

const STREAM_STATE_META: Record<ProductStreamEvidence["state"], { label: string; color: string }> = {
  current: { label: "证据当前", color: "success" },
  degraded: { label: "受限观察", color: "warning" },
  stale: { label: "业务时点过期", color: "error" },
  missing: { label: "尚无证据", color: "default" },
};

const WORK_STAGE_META: Record<DataProductWorkStage, { label: string; color: string }> = {
  safeguard: { label: "先止损", color: "error" },
  approval: { label: "待会签", color: "processing" },
  release_ready: { label: "可验收放行", color: "purple" },
  repair: { label: "修复证据", color: "warning" },
  learning: { label: "真实结果学习", color: "cyan" },
  monitor: { label: "持续监控", color: "success" },
};

function fmtDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

function contractEvidenceLabel(row: DataSourceReadiness): string {
  if (row.key === "SCM") return "内部受控事实";
  if (row.contractSelectionState === "not_required") return "固定契约·无需手选";
  if (row.contractSelectionState === "invalid") return "契约配置无效";
  if (row.contractSelectionState === "missing") return "未选择受控契约";
  return `${row.selectedContractCount} 条已选契约`;
}

function streamAgeLabel(row: ProductStreamEvidence): string {
  if (row.scmEvidence) {
    if (row.scmEvidence.freshnessMaxAgeDays == null) return "当前状态 / 主档（无历史门限）";
    if (row.scmEvidence.businessAgeDays != null) {
      return `业务龄 ${row.scmEvidence.businessAgeDays} 天 / 门限 ${row.scmEvidence.freshnessMaxAgeDays} 天`;
    }
    return "未取得可比较业务时点";
  }
  const evidence = row.evidence;
  if (!evidence) return "—";
  if (evidence.businessAgeDays != null) {
    return `业务龄 ${evidence.businessAgeDays} 天 / 门限 ${evidence.freshnessMaxAgeDays ?? "—"} 天`;
  }
  if (evidence.pipelineAgeHours != null) return `成功距今 ${evidence.pipelineAgeHours} 小时`;
  return "未取得可比较时效";
}

function RequiredStreamEvidence({ summary }: { summary: ProductEvidenceSummary }) {
  const rows = summary.sources.flatMap((source) => source.streams);
  return (
    <Table
      rowKey={(row) => `${row.source}\u0000${row.stream}`}
      size="small"
      pagination={false}
      dataSource={rows}
      scroll={{ x: 1_330 }}
      locale={{ emptyText: "SCM 内部事实不需要外部流证据" }}
      columns={[
        {
          title: "来源",
          dataIndex: "source",
          width: 120,
          render: (source: ProductStreamEvidence["source"]) => DATA_PRODUCT_SOURCE_LABEL[source],
        },
        {
          title: "所需数据流",
          dataIndex: "stream",
          width: 260,
          render: (stream: string, row) => (
            <Space direction="vertical" size={2}>
              <Typography.Text>{dataProductStreamLabel(row.source, stream)}</Typography.Text>
              <Typography.Text type="secondary" code>{stream}</Typography.Text>
            </Space>
          ),
        },
        {
          title: "证据状态",
          dataIndex: "state",
          width: 130,
          render: (state: ProductStreamEvidence["state"]) => (
            <Tag color={STREAM_STATE_META[state].color}>{STREAM_STATE_META[state].label}</Tag>
          ),
        },
        {
          title: "业务截止 / 时效",
          key: "freshness",
          width: 250,
          render: (_, row) => (
            <Space direction="vertical" size={2}>
              <Typography.Text>{row.evidence?.sourceAsOf ?? row.scmEvidence?.asOf ?? "当前状态 / 未取得业务时点"}</Typography.Text>
              <Typography.Text type="secondary">{streamAgeLabel(row)}</Typography.Text>
            </Space>
          ),
        },
        {
          title: "源行 / Staging / 拒收",
          key: "volume",
          width: 210,
          align: "right",
          render: (_, row) => row.evidence
            ? `${row.evidence.sourceRows.toLocaleString("zh-CN")} / ${row.evidence.stagedRows.toLocaleString("zh-CN")} / ${row.evidence.rejectedRows.toLocaleString("zh-CN")}`
            : row.scmEvidence
              ? `${row.scmEvidence.rows.toLocaleString("zh-CN")} / — / —`
              : "—",
        },
        {
          title: "聚合质量控制",
          key: "quality",
          width: 230,
          render: (_, row) => {
            const quality = row.evidence?.quality;
            if (!quality) return <Typography.Text type="secondary">未随批次固化</Typography.Text>;
            if (quality.status === "pass") return <Tag color="success">业务键/数值/对账通过</Tag>;
            return (
              <Space direction="vertical" size={2}>
                <Tag color="warning">待复核</Tag>
                <Typography.Text type="secondary">
                  缺键 {quality.missingBusinessKeyRows} · 重复 {quality.duplicateKeyGroups}组/{quality.duplicateRows}行
                </Typography.Text>
                <Typography.Text type="secondary">
                  非法数值 {quality.invalidNumericValues} · 对账差异 {quality.reconciliationMismatchedRows} · 覆盖不足 {quality.reconciliationInsufficientRows}
                </Typography.Text>
              </Space>
            );
          },
        },
        {
          title: "为何受限",
          dataIndex: "reason",
          width: 300,
        },
      ]}
    />
  );
}

function SupportingStreamEvidence({
  product,
  dataSources,
  supportingObservations,
}: {
  product: DataProductDefinition;
  dataSources: readonly DataSourceReadiness[];
  supportingObservations: readonly JiandaoyunSupportingObservation[];
}) {
  const rows = evaluateProductSupportingEvidence(product, dataSources);
  const observationByStream = new Map(supportingObservations.map((item) => [item.stream, item]));
  if (rows.length === 0) return null;
  return (
    <Card
      size="small"
      title="辅助证据（不参与放行）"
      styles={{ body: { padding: 0 } }}
    >
      <Alert
        banner
        showIcon
        type="info"
        message="用于身份、历史与回查解释；过期或缺失不阻塞产品，也不能替代正式事实或必需流。"
      />
      <Table
        rowKey={(row) => `${row.source}\u0000${row.stream}`}
        size="small"
        pagination={false}
        dataSource={rows}
        scroll={{ x: 1_550 }}
        columns={[
          {
            title: "来源",
            dataIndex: "source",
            width: 110,
            render: (source: ProductStreamEvidence["source"]) => DATA_PRODUCT_SOURCE_LABEL[source],
          },
          {
            title: "辅助数据",
            dataIndex: "stream",
            width: 250,
            render: (stream: string, row) => (
              <Space direction="vertical" size={2}>
                <Typography.Text>{dataProductStreamLabel(row.source, stream)}</Typography.Text>
                <Typography.Text type="secondary" code>{stream}</Typography.Text>
              </Space>
            ),
          },
          {
            title: "当前证据",
            dataIndex: "state",
            width: 130,
            render: (state: ProductStreamEvidence["state"]) => (
              <Tag color={STREAM_STATE_META[state].color}>{STREAM_STATE_META[state].label}</Tag>
            ),
          },
          {
            title: "业务截止 / 最近成功",
            key: "time",
            width: 220,
            render: (_, row) => (
              <Space direction="vertical" size={2}>
                <Typography.Text>{row.evidence?.sourceAsOf ?? "未取得业务时点"}</Typography.Text>
                <Typography.Text type="secondary">{fmtDateTime(row.evidence?.lastSuccessAt ?? null)}</Typography.Text>
              </Space>
            ),
          },
          {
            title: "源行 / Staging / 拒收",
            key: "volume",
            width: 200,
            align: "right",
            render: (_, row) => row.evidence
              ? `${row.evidence.sourceRows.toLocaleString("zh-CN")} / ${row.evidence.stagedRows.toLocaleString("zh-CN")} / ${row.evidence.rejectedRows.toLocaleString("zh-CN")}`
              : "—",
          },
          {
            title: "历史观察摘要",
            key: "observation",
            width: 340,
            render: (_, row) => {
              const observation = row.source === "JIANDAOYUN"
                ? observationByStream.get(row.stream as JiandaoyunSupportingObservation["stream"])
                : undefined;
              if (!observation) return <Typography.Text type="secondary">尚无可安全聚合的历史批次</Typography.Text>;
              const period = observation.businessDateFrom && observation.businessDateThrough
                ? `${observation.businessDateFrom} 至 ${observation.businessDateThrough}`
                : `批次截止 ${observation.sourceAsOf ?? "未取得"}`;
              return (
                <Space direction="vertical" size={2}>
                  <Typography.Paragraph
                    ellipsis={{ rows: 2, tooltip: observation.summary }}
                    style={{ marginBottom: 0 }}
                  >
                    {observation.summary}
                  </Typography.Paragraph>
                  <Typography.Text type="secondary">历史期间：{period}</Typography.Text>
                </Space>
              );
            },
          },
          {
            title: "解释边界",
            dataIndex: "reason",
            width: 300,
            render: (reason: string) => (
              <Typography.Paragraph ellipsis={{ rows: 2, tooltip: reason }} style={{ marginBottom: 0 }}>
                {reason}
              </Typography.Paragraph>
            ),
          },
        ]}
      />
    </Card>
  );
}

const RELEASE_STATUS_META = {
  pending: { label: "待会签", color: "processing" },
  approved: { label: "已批准", color: "success" },
  rejected: { label: "已拒绝", color: "error" },
  revoked: { label: "已撤回", color: "default" },
} as const;

function DataProductReleaseControl({
  product,
  readiness,
  onChanged,
}: {
  product: DataProductDefinition;
  readiness?: DataProductReleaseReadiness;
  onChanged?: () => void | Promise<void>;
}) {
  const { message } = App.useApp();
  const [requestOpen, setRequestOpen] = useState(false);
  const [decisionAction, setDecisionAction] = useState<"approve" | "reject" | "revoke" | null>(null);
  const [saving, setSaving] = useState(false);
  const requestIdempotencyKey = useRef<string | null>(null);
  const [requestForm] = Form.useForm<{
    targetLevel: ReleasedAutomationLevel;
    controlTotalRef: string;
    uatRef: string;
    rollbackPlan: string;
    scopeNote?: string;
  }>();
  const [decisionForm] = Form.useForm<{ note: string }>();
  if (!readiness) return <Alert type="warning" showIcon message="放行台账尚未加载" />;

  const reference = readiness.pendingRelease ?? readiness.activeRelease ?? readiness.latestRelease;
  const submitRequest = async () => {
    const values = await requestForm.validateFields();
    setSaving(true);
    try {
      await postJson("/api/report/data-product-releases", {
        productId: product.id,
        ...values,
        idempotencyKey: requestIdempotencyKey.current ??= globalThis.crypto.randomUUID(),
      });
      message.success("放行申请已进入责任人会签");
      setRequestOpen(false);
      requestIdempotencyKey.current = null;
      requestForm.resetFields();
      await onChanged?.();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const submitDecision = async () => {
    if (!decisionAction || !reference) return;
    const { note } = await decisionForm.validateFields();
    setSaving(true);
    try {
      await putJson("/api/report/data-product-releases", {
        id: reference.id,
        action: decisionAction,
        note,
        expectedVersion: reference.version,
      });
      message.success(decisionAction === "approve" ? "放行已批准" : decisionAction === "reject" ? "申请已拒绝" : "放行已立即撤回");
      setDecisionAction(null);
      decisionForm.resetFields();
      await onChanged?.();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      size="small"
      title="产品级放行与回滚"
      extra={(
        <Space size={4} wrap>
          <Tag color={readiness.effectiveLevel === "A0" ? "default" : readiness.effectiveLevel === "A1" ? "gold" : "purple"}>
            当前 {readiness.effectiveLevel} · {DATA_PRODUCT_AUTOMATION_LABEL[readiness.effectiveLevel]}
          </Tag>
          {reference ? <Tag color={RELEASE_STATUS_META[reference.status].color}>{RELEASE_STATUS_META[reference.status].label}</Tag> : null}
        </Space>
      )}
    >
      <Typography.Paragraph style={{ marginBottom: reference ? 10 : 12 }}>
        {readiness.gate}
      </Typography.Paragraph>
      {reference ? (
        <Descriptions size="small" column={{ xs: 1, md: 2, xl: 4 }} styles={{ label: { color: "#64748b" } }}>
          <Descriptions.Item label="申请目标">{reference.targetLevel} · {DATA_PRODUCT_AUTOMATION_LABEL[reference.targetLevel]}</Descriptions.Item>
          <Descriptions.Item label="发起人">{reference.requestedByName ?? `用户#${reference.requestedBy}`}</Descriptions.Item>
          <Descriptions.Item label="控制总量证据">{reference.controlTotalRef}</Descriptions.Item>
          <Descriptions.Item label="UAT 证据">{reference.uatRef}</Descriptions.Item>
          <Descriptions.Item label="回滚方案" span={2}>{reference.rollbackPlan}</Descriptions.Item>
          <Descriptions.Item label="审批结论" span={2}>{reference.decisionNote ?? "待会签"}</Descriptions.Item>
        </Descriptions>
      ) : null}
      <Space size={[8, 8]} wrap style={{ marginTop: reference ? 8 : 0 }}>
        {readiness.canRequest ? (
          <Button type="primary" size="small" onClick={() => {
            requestForm.setFieldsValue({ targetLevel: product.maxAutomation === "A3" ? "A3" : "A2" });
            requestIdempotencyKey.current = globalThis.crypto.randomUUID();
            setRequestOpen(true);
          }}>
            发起受控放行
          </Button>
        ) : null}
        {readiness.canApprove ? <Button type="primary" size="small" onClick={() => setDecisionAction("approve")}>批准</Button> : null}
        {readiness.canReject ? <Button danger size="small" onClick={() => setDecisionAction("reject")}>拒绝</Button> : null}
        {readiness.canRevoke ? <Button danger size="small" onClick={() => setDecisionAction("revoke")}>立即撤回</Button> : null}
        {!readiness.canRequest && !readiness.canApprove && !readiness.canReject && !readiness.canRevoke ? (
          <Typography.Text type="secondary">当前无可执行动作；先完成上方门禁或由另一名责任审批人会签。</Typography.Text>
        ) : null}
      </Space>

      <Modal
        title={`申请放行 · ${product.title}`}
        open={requestOpen}
        okText="提交会签"
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => {
          setRequestOpen(false);
          requestIdempotencyKey.current = null;
        }}
        onOk={() => void submitRequest()}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="批准只提升数据产品的建议/草稿能力，不会直接过账、核销或修改正式主数据。"
        />
        <Form form={requestForm} layout="vertical">
          <Form.Item name="targetLevel" label="申请级别" rules={[{ required: true }]}>
            <Select options={product.maxAutomation === "A3"
              ? [{ value: "A2", label: "A2 · 建议" }, { value: "A3", label: "A3 · 草稿（仍需业务审批）" }]
              : [{ value: "A2", label: "A2 · 建议" }]}
            />
          </Form.Item>
          <Form.Item name="controlTotalRef" label="控制总量证据编号" rules={[{ required: true, min: 3 }]}>
            <Input placeholder="例如：CT-20260812-001" maxLength={200} />
          </Form.Item>
          <Form.Item name="uatRef" label="业务 UAT 证据编号" rules={[{ required: true, min: 3 }]}>
            <Input placeholder="例如：UAT-20260812-责任人" maxLength={200} />
          </Form.Item>
          <Form.Item name="rollbackPlan" label="回滚/停用方案" rules={[{ required: true, min: 10 }]}>
            <Input.TextArea rows={3} maxLength={1_000} showCount placeholder="说明触发条件、责任人，以及如何停止建议或草稿生成" />
          </Form.Item>
          <Form.Item name="scopeNote" label="适用范围（可选）">
            <Input.TextArea rows={2} maxLength={500} showCount placeholder="品牌、渠道、仓库、日期窗口或其他限制" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={decisionAction === "approve" ? "批准数据产品放行" : decisionAction === "reject" ? "拒绝放行申请" : "立即撤回数据产品放行"}
        open={decisionAction != null}
        okText={decisionAction === "approve" ? "确认批准" : decisionAction === "reject" ? "确认拒绝" : "确认撤回"}
        okButtonProps={{ danger: decisionAction !== "approve" }}
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => setDecisionAction(null)}
        onOk={() => void submitDecision()}
        destroyOnHidden
      >
        <Form form={decisionForm} layout="vertical">
          <Form.Item name="note" label="审批/撤回说明" rules={[{ required: true, min: 5 }]}>
            <Input.TextArea rows={3} maxLength={500} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

function ProductOperatingContract({
  product,
  summary,
  dataSources,
  supportingObservations,
  release,
  outcome,
  onReleaseChanged,
}: {
  product: DataProductDefinition;
  summary: ProductEvidenceSummary;
  dataSources: readonly DataSourceReadiness[];
  supportingObservations: readonly JiandaoyunSupportingObservation[];
  release?: DataProductReleaseReadiness;
  outcome?: DataProductOutcomeReadiness;
  onReleaseChanged?: () => void | Promise<void>;
}) {
  const current = currentProductAutomation(summary);
  const effectiveLevel = release?.effectiveLevel ?? current.level;
  const timeWindow = summary.businessTimeWindow;
  return (
    <Space direction="vertical" size={10} style={{ display: "flex" }}>
      <Space size={[6, 6]} wrap>
        <Tag color="blue">契约 v{product.contractVersion}</Tag>
        <Tag>{DATA_PRODUCT_CADENCE_LABEL[product.cadence]}刷新</Tag>
        <Tag>决策 SLA {product.decisionSlaHours}h</Tag>
        <Tag color={effectiveLevel === "A0" ? "default" : effectiveLevel === "A1" ? "gold" : "purple"}>
          当前 {effectiveLevel} · {DATA_PRODUCT_AUTOMATION_LABEL[effectiveLevel]}
        </Tag>
        <Tag color="purple">
          UAT 后上限 {product.maxAutomation} · {DATA_PRODUCT_AUTOMATION_LABEL[product.maxAutomation]}
        </Tag>
      </Space>
      <div>
        <Typography.Text strong>核心指标：</Typography.Text>
        <Space size={[4, 4]} wrap style={{ marginLeft: 6 }}>
          {product.metricIds.map((metricId) => (
            <Tag key={metricId} title={metricTooltip(metricId)}>
              {metric(metricId)?.label ?? metricId}
            </Tag>
          ))}
        </Space>
      </div>
      <Typography.Paragraph style={{ marginBottom: 0 }}>
        <Typography.Text strong>当前自动化判断：</Typography.Text>
        {current.reason}
      </Typography.Paragraph>
      <Typography.Paragraph style={{ marginBottom: 0 }}>
        <Typography.Text strong>共同可比截止：</Typography.Text>
        {timeWindow.state === "unavailable"
          ? "尚无可比较的业务日期证据"
          : `${timeWindow.commonAsOf}（最新来源 ${timeWindow.latestAsOf}，时点跨度 ${timeWindow.spanDays} 天）`}
        {timeWindow.undatedStreams > 0
          ? `；另有 ${timeWindow.undatedStreams} 条时效敏感流缺业务日期`
          : ""}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        <Typography.Text strong>自动化护栏：</Typography.Text>
        {product.automationGuardrail}
      </Typography.Paragraph>
      <DataProductReleaseControl product={product} readiness={release} onChanged={onReleaseChanged} />
      <DataProductOutcomeControl product={product} readiness={outcome} onChanged={onReleaseChanged} />
      <RequiredStreamEvidence summary={summary} />
      <SupportingStreamEvidence
        product={product}
        dataSources={dataSources}
        supportingObservations={supportingObservations}
      />
    </Space>
  );
}

export default function DecisionReadinessPanel({
  dataSources = [],
  dataProductReleases = [],
  dataProductOutcomes = [],
  supportingObservations = [],
  onReleaseChanged,
  focusProductId,
}: {
  dataSources?: DataSourceReadiness[];
  dataProductReleases?: DataProductReleaseReadiness[];
  dataProductOutcomes?: DataProductOutcomeReadiness[];
  supportingObservations?: JiandaoyunSupportingObservation[];
  onReleaseChanged?: () => void | Promise<void>;
  focusProductId?: string;
}) {
  const { message } = App.useApp();
  const ready = DECISION_CAPABILITIES.filter((item) => capabilityReadiness(item) === "ready").length;
  const partial = DECISION_CAPABILITIES.filter((item) => capabilityReadiness(item) === "partial").length;
  const external = dataSources.filter((item) => item.key !== "SCM");
  const operationalSources = external.filter((item) => item.state === "operational").length;
  const observedSources = external.filter((item) => item.state === "observation").length;
  const workQueue = useMemo(
    () => buildDataProductWorkQueue(DATA_PRODUCTS, dataSources, dataProductReleases, dataProductOutcomes),
    [dataSources, dataProductReleases, dataProductOutcomes],
  );
  const exportEvidence = () => {
    const payload = buildDataProductEvidenceExport(
      DATA_PRODUCTS,
      dataSources,
      dataProductReleases,
      dataProductOutcomes,
      new Date(),
      supportingObservations,
    );
    exportCsv(payload.filename, payload.headers, payload.rows);
    message.success(`已导出 ${payload.rows.length} 行三方数据产品决策证据`);
  };

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={`决策能力门禁：${ready} 项当前可用，${partial} 项部分可用`}
        description="这里衡量的是数据前提是否成立，不是图表数量。未满足前提的能力必须留白或显示数据不足，禁止用 0、估算值或演示数据伪装完成。"
      />
      <Row gutter={[12, 12]}>
        {DECISION_CAPABILITIES.map((capability) => {
          const state = capabilityReadiness(capability);
          const meta = STATE_META[state];
          const percent = Math.round((capability.proven.length / capability.required.length) * 100);
          const missing = capability.required.filter((item) => !capability.proven.includes(item));
          return (
            <Col xs={24} xl={12} key={capability.id}>
              <Card
                size="small"
                title={capability.title}
                extra={<Tag color={meta.color}>{meta.label}</Tag>}
                style={{ height: "100%" }}
              >
                <Typography.Paragraph style={{ marginBottom: 8 }}>
                  <Typography.Text strong>要回答：</Typography.Text>
                  {capability.decision}
                </Typography.Paragraph>
                <Progress
                  percent={percent}
                  strokeColor={meta.stroke}
                  format={() => `${capability.proven.length}/${capability.required.length} 前提`}
                  aria-label={`${capability.title}已满足 ${capability.proven.length} 项，共 ${capability.required.length} 项前提`}
                />
                <Typography.Text type="secondary">已证明</Typography.Text>
                <div style={{ marginTop: 4, marginBottom: 8 }}>
                  <Space size={[4, 4]} wrap>
                    {capability.proven.map((item) => <Tag color="green" key={item}>{item}</Tag>)}
                  </Space>
                </div>
                {missing.length > 0 ? (
                  <>
                    <Typography.Text type="secondary">待解锁</Typography.Text>
                    <div style={{ marginTop: 4, marginBottom: 8 }}>
                      <Space size={[4, 4]} wrap>
                        {missing.map((item) => <Tag key={item}>{item}</Tag>)}
                      </Space>
                    </div>
                  </>
                ) : null}
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  <Typography.Text strong>下一步（{capability.owner}）：</Typography.Text>
                  {capability.nextAction}
                </Typography.Paragraph>
              </Card>
            </Col>
          );
        })}
      </Row>
      <Card
        size="small"
        title="数据产品动态行动队列"
        style={{ marginTop: 16 }}
        extra={(
          <Space size={6} wrap>
            <Tag color="blue">待推进 {workQueue.filter((item) => item.stage !== "monitor").length}/{workQueue.length}</Tag>
            <Button size="small" icon={<DownloadOutlined />} onClick={exportEvidence}>
              导出决策证据包
            </Button>
          </Space>
        )}
        styles={{ body: { padding: 0 } }}
      >
        <Alert
          banner
          showIcon
          type="info"
          message="优先级由当前证据自动重排：失效放行 → 待会签 → 可验收放行 → 证据修复 → 真实结果学习 → 持续监控。同组内按决策 SLA 排序，不伪造商业价值精确分。"
        />
        <Table
          rowKey="productId"
          size="small"
          pagination={false}
          dataSource={workQueue}
          scroll={{ x: 1_420 }}
          columns={[
            {
              title: "顺位",
              key: "priority",
              width: 70,
              align: "center",
              render: (_, __, index) => index + 1,
            },
            {
              title: "数据产品",
              dataIndex: "title",
              width: 170,
              fixed: "left",
              render: (title: string, row) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>{title}</Typography.Text>
                  <Typography.Text type="secondary">当前 {row.effectiveLevel}</Typography.Text>
                </Space>
              ),
            },
            {
              title: "处置阶段",
              dataIndex: "stage",
              width: 120,
              render: (stage: DataProductWorkStage) => (
                <Tag color={WORK_STAGE_META[stage].color}>{WORK_STAGE_META[stage].label}</Tag>
              ),
            },
            { title: "下一个最佳动作", dataIndex: "nextAction", width: 360 },
            {
              title: "首要阻塞 / 当前证据",
              dataIndex: "bottleneck",
              width: 390,
              render: (value: string) => (
                <Typography.Paragraph ellipsis={{ rows: 2, tooltip: value }} style={{ marginBottom: 0 }}>
                  {value}
                </Typography.Paragraph>
              ),
            },
            {
              title: "Owner / SLA",
              key: "owner",
              width: 180,
              render: (_, row) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text>{row.owner}</Typography.Text>
                  <Typography.Text type="secondary">{row.decisionSlaHours} 小时</Typography.Text>
                </Space>
              ),
            },
            {
              title: "行动入口",
              key: "action",
              width: 150,
              fixed: "right",
              render: (_, row) => (
                <Button
                  type="link"
                  size="small"
                  href={row.actionHref}
                  style={{ paddingInline: 0 }}
                >
                  {row.actionLabel} <ArrowRightOutlined />
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <DataAssetDecisionCoverage
        dataSources={dataSources}
        dataProductReleases={dataProductReleases}
      />
      <Card
        size="small"
        title="三方来源证据矩阵"
        style={{ marginTop: 16 }}
        extra={(
          <Space size={4} wrap>
            <Tag color="green">外部已放行 {operationalSources}/3</Tag>
            <Tag color="gold">仅观察 {observedSources}/3</Tag>
          </Space>
        )}
        styles={{ body: { padding: 0 } }}
      >
        <Alert
          banner
          showIcon
          type="info"
          message="源行是连接器读取的当前成功流合计；目录和控制流可以不入 staging，因此差额不自动等于丢数。拒收行需单独处理。"
        />
        <Table
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={dataSources}
          scroll={{ x: 1_260 }}
          locale={{ emptyText: "尚无来源证据；不能把静态目录当成数据接入" }}
          columns={[
            {
              title: "来源 / 当前权威",
              key: "source",
              width: 190,
              fixed: "left",
              sorter: (a, b) => a.label.localeCompare(b.label, "zh-CN"),
              render: (_, row) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>{row.label}</Typography.Text>
                  <Tag color={SOURCE_STATE_META[row.state].color}>
                    {SOURCE_STATE_META[row.state].label}
                  </Tag>
                </Space>
              ),
            },
            {
              title: "配置 / 契约",
              key: "contract",
              width: 170,
              render: (_, row) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text>{row.configured ? "凭据已配置" : "凭据未齐"}</Typography.Text>
                  <Typography.Text type="secondary">
                    {contractEvidenceLabel(row)}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: "成功流 / 时效 / 异常",
              key: "streams",
              width: 220,
              sorter: (a, b) => a.successfulStreams - b.successfulStreams,
              render: (_, row) => {
                const current = row.streams?.filter((item) => item.freshness === "current").length ?? 0;
                const stale = row.streams?.filter((item) => item.freshness === "stale").length ?? 0;
                const qualityReview = row.streams?.filter((item) => item.quality?.status === "review").length ?? 0;
                const unknown = Math.max(0, row.successfulStreams - current - stale);
                return (
                  <Space direction="vertical" size={2}>
                    <Typography.Text>{row.successfulStreams} 条成功流</Typography.Text>
                    <Typography.Text type={stale > 0 ? "danger" : "secondary"}>
                      当前 {current} · 过期 {stale} · 未定 {unknown}
                    </Typography.Text>
                    <Typography.Text type={row.latestFailedStreams + row.latestRunningStreams + qualityReview > 0 ? "danger" : "secondary"}>
                      失败 {row.latestFailedStreams} · 运行中 {row.latestRunningStreams} · 质量待复核 {qualityReview}
                    </Typography.Text>
                  </Space>
                );
              },
            },
            {
              title: "业务截止 / 最近成功",
              key: "time",
              width: 230,
              sorter: (a, b) => String(a.sourceAsOfEnd ?? "").localeCompare(String(b.sourceAsOfEnd ?? "")),
              render: (_, row) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text>
                    {row.sourceAsOfStart && row.sourceAsOfEnd
                      ? row.sourceAsOfStart === row.sourceAsOfEnd
                        ? row.sourceAsOfEnd
                        : `${row.sourceAsOfStart} → ${row.sourceAsOfEnd}`
                      : "内部实时 / 未提供"}
                  </Typography.Text>
                  <Typography.Text type="secondary">{fmtDateTime(row.lastSuccessAt)}</Typography.Text>
                </Space>
              ),
            },
            {
              title: "源行 / Staging / 拒收",
              key: "volume",
              width: 220,
              align: "right",
              sorter: (a, b) => a.sourceRows - b.sourceRows,
              render: (_, row) => `${row.sourceRows.toLocaleString("zh-CN")} / ${row.stagedRows.toLocaleString("zh-CN")} / ${row.rejectedRows.toLocaleString("zh-CN")}`,
            },
            {
              title: "身份观察 / 开放异常",
              key: "identity",
              width: 180,
              align: "right",
              sorter: (a, b) => (a.openIdentityExceptions ?? -1) - (b.openIdentityExceptions ?? -1),
              render: (_, row) => row.openIdentityExceptions == null
                ? "不适用"
                : `${(row.observedIdentities ?? 0).toLocaleString("zh-CN")} / ${row.openIdentityExceptions.toLocaleString("zh-CN")}`,
            },
            {
              title: "当前门禁与下一步",
              key: "gate",
              width: 360,
              render: (_, row) => (
                <Space direction="vertical" size={2}>
                  <Typography.Paragraph
                    ellipsis={{ rows: 2, tooltip: row.gate }}
                    style={{ marginBottom: 0 }}
                  >
                    {row.gate}
                  </Typography.Paragraph>
                  <Typography.Paragraph
                    type="secondary"
                    ellipsis={{ rows: 2, tooltip: row.nextAction }}
                    style={{ marginBottom: 0 }}
                  >
                    {row.nextAction}
                  </Typography.Paragraph>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Card
        size="small"
        title="三方数据产品目录"
        style={{ marginTop: 16 }}
        extra={<Tag color="blue">{DATA_PRODUCTS.length} 个目标契约</Tag>}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="目录定义不等于当前已解锁"
          description="每个产品登记唯一指标、版本、刷新节奏、决策 SLA、自动化上限与放行门禁；展开行可逐流查看业务截止、时效、质量和当前 A0/A1 判断。"
        />
        <Table
          key={focusProductId || "data-product-catalog"}
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={DATA_PRODUCTS}
          scroll={{ x: 1_260 }}
          expandable={{
            defaultExpandedRowKeys: focusProductId ? [focusProductId] : [],
            expandedRowRender: (row) => {
              const summary = evaluateProductSourceEvidence(row, dataSources);
              return (
                <ProductOperatingContract
                  product={row}
                  summary={summary}
                  dataSources={dataSources}
                  supportingObservations={supportingObservations}
                  release={dataProductReleases.find((item) => item.productId === row.id)}
                  outcome={dataProductOutcomes.find((item) => item.productId === row.id)}
                  onReleaseChanged={onReleaseChanged}
                />
              );
            },
            rowExpandable: (row) => row.sources.some((source) => source !== "SCM")
              || Object.keys(row.supportingStreams ?? {}).length > 0,
            columnWidth: 44,
          }}
          onRow={(row) => ({ id: `data-product-${row.id}` })}
          columns={[
            {
              title: "数据产品",
              dataIndex: "title",
              width: 150,
              fixed: "left",
              render: (value: string, row) => (
                <div>
                  <Typography.Text strong>{value}</Typography.Text>
                  <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                    v{row.contractVersion} · {DATA_PRODUCT_CADENCE_LABEL[row.cadence]} · {row.grain}
                  </Typography.Text>
                </div>
              ),
            },
            { title: "要回答的决策", dataIndex: "decision", width: 270 },
            {
              title: "来源",
              dataIndex: "sources",
              width: 250,
              render: (sources: (keyof typeof DATA_PRODUCT_SOURCE_LABEL)[]) => (
                <Space size={[4, 4]} wrap>
                  {sources.map((source) => <Tag key={source}>{DATA_PRODUCT_SOURCE_LABEL[source]}</Tag>)}
                </Space>
              ),
            },
            {
              title: "当前来源证据",
              key: "sourceEvidence",
              width: 170,
              render: (_, row) => {
                const evidence = evaluateProductSourceEvidence(row, dataSources);
                const color = evidence.operationalSources === row.sources.length
                  ? "success"
                  : evidence.observedSources === row.sources.length && evidence.staleStreams === 0
                    ? "warning"
                    : "error";
                const label = evidence.operationalSources === row.sources.length
                  ? "来源已放行"
                  : evidence.missingStreams > 0
                    ? "来源/所需流缺失"
                    : evidence.staleStreams > 0
                      ? "所需流已过期"
                      : evidence.observedSources === row.sources.length
                        ? "来源齐·未放行"
                        : "来源尚不可用";
                return (
                  <Space direction="vertical" size={2}>
                    <Tag color={color}>{label}</Tag>
                    <Typography.Text type="secondary">
                      观察 {evidence.observedSources}/{row.sources.length} · 放行 {evidence.operationalSources}/{row.sources.length}
                      {evidence.missingStreams > 0 ? ` · 缺流 ${evidence.missingStreams}` : ""}
                      {evidence.staleStreams > 0 ? ` · 过期 ${evidence.staleStreams}` : ""}
                      {evidence.degradedStreams > 0 ? ` · 受限 ${evidence.degradedStreams}` : ""}
                    </Typography.Text>
                  </Space>
                );
              },
            },
            {
              title: "Owner / SLA",
              key: "owner",
              width: 170,
              render: (_, row) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text>{row.owner}</Typography.Text>
                  <Typography.Text type="secondary">{row.decisionSlaHours} 小时</Typography.Text>
                </Space>
              ),
            },
            {
              title: "自动化边界",
              key: "automation",
              width: 165,
              render: (_, row) => {
                const current = currentProductAutomation(evaluateProductSourceEvidence(row, dataSources));
                const effective = dataProductReleases.find((item) => item.productId === row.id)?.effectiveLevel ?? current.level;
                return (
                  <Space direction="vertical" size={2}>
                    <Tag color={effective === "A0" ? "default" : effective === "A1" ? "gold" : "purple"}>
                      当前 {effective} · {DATA_PRODUCT_AUTOMATION_LABEL[effective]}
                    </Tag>
                    <Typography.Text type="secondary">
                      UAT 后上限 {row.maxAutomation} · {DATA_PRODUCT_AUTOMATION_LABEL[row.maxAutomation]}
                    </Typography.Text>
                  </Space>
                );
              },
            },
            {
              title: "目标权威级",
              dataIndex: "targetAuthority",
              width: 120,
              render: (authority: DataProductAuthority) => (
                <Tag color={authority === "financial" ? "purple" : authority === "operational" ? "green" : "gold"}>
                  {DATA_PRODUCT_AUTHORITY_LABEL[authority]}
                </Tag>
              ),
            },
            { title: "放行门禁", dataIndex: "releaseGate", width: 330 },
          ]}
        />
      </Card>
    </div>
  );
}
