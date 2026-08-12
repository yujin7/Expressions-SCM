"use client";

import { Alert, Card, Col, Progress, Row, Space, Table, Tag, Typography } from "antd";
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
  type DataProductAuthority,
  type DataProductDefinition,
} from "@/components/data-products";
import {
  currentProductAutomation,
  evaluateProductSourceEvidence,
  type ProductEvidenceSummary,
  type ProductStreamEvidence,
} from "@/components/data-product-source-evidence";
import { metric, metricTooltip } from "@/components/metrics";
import type {
  DataSourceReadiness,
  DataSourceState,
} from "@/server/modules/report/data-source-readiness";

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
      scroll={{ x: 1_100 }}
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
          render: (stream: string) => <Typography.Text code>{stream}</Typography.Text>,
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
          title: "为何受限",
          dataIndex: "reason",
          width: 300,
        },
      ]}
    />
  );
}

function ProductOperatingContract({
  product,
  summary,
}: {
  product: DataProductDefinition;
  summary: ProductEvidenceSummary;
}) {
  const current = currentProductAutomation(summary);
  return (
    <Space direction="vertical" size={10} style={{ display: "flex" }}>
      <Space size={[6, 6]} wrap>
        <Tag color="blue">契约 v{product.contractVersion}</Tag>
        <Tag>{DATA_PRODUCT_CADENCE_LABEL[product.cadence]}刷新</Tag>
        <Tag>决策 SLA {product.decisionSlaHours}h</Tag>
        <Tag color={current.level === "A1" ? "gold" : "default"}>
          当前 {current.level} · {DATA_PRODUCT_AUTOMATION_LABEL[current.level]}
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
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        <Typography.Text strong>自动化护栏：</Typography.Text>
        {product.automationGuardrail}
      </Typography.Paragraph>
      <RequiredStreamEvidence summary={summary} />
    </Space>
  );
}

export default function DecisionReadinessPanel({
  dataSources = [],
}: {
  dataSources?: DataSourceReadiness[];
}) {
  const ready = DECISION_CAPABILITIES.filter((item) => capabilityReadiness(item) === "ready").length;
  const partial = DECISION_CAPABILITIES.filter((item) => capabilityReadiness(item) === "partial").length;
  const external = dataSources.filter((item) => item.key !== "SCM");
  const operationalSources = external.filter((item) => item.state === "operational").length;
  const observedSources = external.filter((item) => item.state === "observation").length;

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
                const unknown = Math.max(0, row.successfulStreams - current - stale);
                return (
                  <Space direction="vertical" size={2}>
                    <Typography.Text>{row.successfulStreams} 条成功流</Typography.Text>
                    <Typography.Text type={stale > 0 ? "danger" : "secondary"}>
                      当前 {current} · 过期 {stale} · 未定 {unknown}
                    </Typography.Text>
                    <Typography.Text type={row.latestFailedStreams + row.latestRunningStreams > 0 ? "danger" : "secondary"}>
                      最新失败 {row.latestFailedStreams} · 运行中 {row.latestRunningStreams}
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
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={DATA_PRODUCTS}
          scroll={{ x: 1_260 }}
          expandable={{
            expandedRowRender: (row) => {
              const summary = evaluateProductSourceEvidence(row, dataSources);
              return <ProductOperatingContract product={row} summary={summary} />;
            },
            rowExpandable: (row) => row.sources.some((source) => source !== "SCM"),
            columnWidth: 44,
          }}
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
                return (
                  <Space direction="vertical" size={2}>
                    <Tag color={current.level === "A1" ? "gold" : "default"}>
                      当前 {current.level} · {DATA_PRODUCT_AUTOMATION_LABEL[current.level]}
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
