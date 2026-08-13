"use client";

import { useRef, useState, type ReactNode } from "react";
import dayjs, { type Dayjs } from "dayjs";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";

import type { DataProductDefinition } from "@/components/data-products";
import { postJson } from "@/components/fetchJson";
import { metric, metricTooltip } from "@/components/metrics";
import type {
  DataProductOutcomeDecision,
  DataProductOutcomeDto,
  DataProductOutcomeReadiness,
  DataProductOutcomeReason,
  DataProductOutcomeResult,
} from "@/server/modules/report/data-product-outcome";

const DECISION_META: Record<DataProductOutcomeDecision, { label: string; color: string }> = {
  accepted: { label: "采纳", color: "success" },
  modified: { label: "修改后采纳", color: "processing" },
  rejected: { label: "拒绝", color: "error" },
  deferred: { label: "暂缓", color: "default" },
};

const RESULT_META: Record<DataProductOutcomeResult, { label: string; color: string }> = {
  pending: { label: "待观察", color: "default" },
  positive: { label: "正向", color: "success" },
  neutral: { label: "中性", color: "blue" },
  negative: { label: "负向", color: "warning" },
  false_positive: { label: "误报", color: "error" },
};

const REASON_LABEL: Record<DataProductOutcomeReason, string> = {
  data_quality: "数据质量",
  identity_gap: "身份映射缺口",
  timing: "时点/时效不合适",
  business_constraint: "业务约束",
  duplicate: "重复建议",
  low_confidence: "置信度不足",
  other: "其他",
};

interface OutcomeFormValues {
  decisionRef: string;
  businessDate: Dayjs;
  decision: DataProductOutcomeDecision;
  result: DataProductOutcomeResult;
  handlingMinutes?: number | null;
  savedHours?: number | null;
  cashImpact?: number | null;
  reasonCode?: DataProductOutcomeReason | null;
  evidenceRef?: string | null;
  note: string;
}

function metricValue(value: string | null, suffix = ""): string {
  return value == null ? "数据不足" : `${value}${suffix}`;
}

function metricLabel(id: string): ReactNode {
  return <span title={metricTooltip(id)}>{metric(id)?.label ?? id}</span>;
}

export default function DataProductOutcomeControl({
  product,
  readiness,
  onChanged,
}: {
  product: DataProductDefinition;
  readiness?: DataProductOutcomeReadiness;
  onChanged?: () => void | Promise<void>;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<OutcomeFormValues>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [supersedesId, setSupersedesId] = useState<number | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  if (!readiness) return <Alert type="warning" showIcon message="真实结果台账尚未加载" />;

  const beginNew = () => {
    setSupersedesId(null);
    idempotencyKey.current = globalThis.crypto.randomUUID();
    form.resetFields();
    form.setFieldsValue({
      businessDate: dayjs(),
      decision: "accepted",
      result: "pending",
    });
    setOpen(true);
  };

  const beginCorrection = (row: DataProductOutcomeDto) => {
    setSupersedesId(row.id);
    idempotencyKey.current = globalThis.crypto.randomUUID();
    form.setFieldsValue({
      decisionRef: row.decisionRef,
      businessDate: dayjs(row.businessDate),
      decision: row.decision,
      result: row.result,
      handlingMinutes: row.handlingMinutes,
      savedHours: row.savedHours == null ? null : Number(row.savedHours),
      cashImpact: row.cashImpact == null ? null : Number(row.cashImpact),
      reasonCode: row.reasonCode,
      evidenceRef: row.evidenceRef,
      note: row.note,
    });
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await postJson("/api/report/data-product-outcomes", {
        ...values,
        productId: product.id,
        businessDate: values.businessDate.format("YYYY-MM-DD"),
        supersedesId,
        idempotencyKey: idempotencyKey.current ??= globalThis.crypto.randomUUID(),
      });
      message.success(supersedesId == null ? "真实结果已登记" : "纠正记录已追加，原记录完整保留");
      setOpen(false);
      setSupersedesId(null);
      idempotencyKey.current = null;
      form.resetFields();
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
      title="真实结果与持续学习"
      extra={(
        <Space size={6} wrap>
          <Tag color={readiness.outcomeCount > 0 ? "blue" : "default"}>{readiness.outcomeCount} 条有效结果</Tag>
          {readiness.canRecord ? <Button type="primary" size="small" onClick={beginNew}>登记真实结果</Button> : null}
        </Space>
      )}
    >
      <Alert
        type={readiness.canRecord ? "info" : "warning"}
        showIcon
        message={readiness.gate}
        description="指标只按当前版本记录汇总；缺少样本时显示“数据不足”，不会用 0 代替未知，也不会自动升级 A2/A3。"
        style={{ marginBottom: 10 }}
      />
      <Descriptions size="small" bordered column={{ xs: 1, sm: 2, lg: 3 }}>
        <Descriptions.Item label={metricLabel("dataProductAdoptionRate")}>{metricValue(readiness.adoptionRatePct, "%")}</Descriptions.Item>
        <Descriptions.Item label={metricLabel("dataProductFalsePositiveRate")}>{metricValue(readiness.falsePositiveRatePct, "%")}</Descriptions.Item>
        <Descriptions.Item label={metricLabel("dataProductHandlingMinutes")}>{metricValue(readiness.avgHandlingMinutes, " 分钟")}</Descriptions.Item>
        <Descriptions.Item label={metricLabel("dataProductSavedHours")}>{metricValue(readiness.savedHoursTotal, " 小时")}</Descriptions.Item>
        <Descriptions.Item label={metricLabel("dataProductCashImpact")}>
          {readiness.cashVisible ? metricValue(readiness.cashImpactTotal, " CNY") : "按角色隐藏"}
        </Descriptions.Item>
        <Descriptions.Item label="待观察">{readiness.pendingCount}</Descriptions.Item>
      </Descriptions>
      {readiness.latest.length > 0 ? (
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={readiness.latest}
          scroll={{ x: 920 }}
          style={{ marginTop: 10 }}
          columns={[
            { title: "决策编号", dataIndex: "decisionRef", width: 170 },
            { title: "业务日", dataIndex: "businessDate", width: 110 },
            {
              title: "业务决定",
              dataIndex: "decision",
              width: 120,
              render: (value: DataProductOutcomeDecision) => <Tag color={DECISION_META[value].color}>{DECISION_META[value].label}</Tag>,
            },
            {
              title: "真实结果",
              dataIndex: "result",
              width: 100,
              render: (value: DataProductOutcomeResult) => <Tag color={RESULT_META[value].color}>{RESULT_META[value].label}</Tag>,
            },
            {
              title: "结果说明",
              dataIndex: "note",
              ellipsis: true,
              render: (value: string, row: DataProductOutcomeDto) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text ellipsis={{ tooltip: value }} style={{ maxWidth: 300 }}>{value}</Typography.Text>
                  {row.reasonCode ? <Typography.Text type="secondary">{REASON_LABEL[row.reasonCode]}</Typography.Text> : null}
                </Space>
              ),
            },
            {
              title: "操作",
              key: "action",
              width: 80,
              fixed: "right",
              render: (_: unknown, row: DataProductOutcomeDto) => readiness.canCorrect
                ? <Button type="link" size="small" onClick={() => beginCorrection(row)}>纠正</Button>
                : null,
            },
          ]}
        />
      ) : (
        <Typography.Text type="secondary" style={{ display: "block", marginTop: 10 }}>
          尚无真实结果样本。待产品受控放行后，从第一条可核验证据开始积累。
        </Typography.Text>
      )}

      <Modal
        title={supersedesId == null ? `登记真实结果 · ${product.title}` : `追加纠正记录 · ${product.title}`}
        open={open}
        okText={supersedesId == null ? "登记" : "追加纠正"}
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => {
          setOpen(false);
          idempotencyKey.current = null;
        }}
        onOk={() => void submit()}
        width={760}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          message={supersedesId == null
            ? "只登记已经发生的业务决定或结果，不填写预测收益。"
            : "系统不会覆盖原记录；本次内容将成为新的有效版本。"}
          style={{ marginBottom: 14 }}
        />
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item name="decisionRef" label="建议/决策编号" rules={[{ required: true, min: 3 }]}>
                <Input disabled={supersedesId != null} maxLength={200} placeholder="例如：R11-20260813-SKU001" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="businessDate" label="业务日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: "100%" }} disabledDate={(date) => date.isAfter(dayjs(), "day")} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="decision" label="业务决定" rules={[{ required: true }]}>
                <Select options={Object.entries(DECISION_META).map(([value, meta]) => ({ value, label: meta.label }))} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="result" label="真实结果" rules={[{ required: true }]}>
                <Select options={Object.entries(RESULT_META).map(([value, meta]) => ({ value, label: meta.label }))} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="handlingMinutes" label="处理时长（分钟）">
                <InputNumber min={0} max={525_600} precision={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="savedHours" label="实际节省工时">
                <InputNumber min={0} precision={2} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            {readiness.cashVisible ? (
              <Col xs={24} md={8}>
                <Form.Item name="cashImpact" label="实际现金影响（CNY）">
                  <InputNumber precision={2} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
            ) : null}
            <Col xs={24} md={12}>
              <Form.Item name="reasonCode" label="原因（修改/拒绝/负面/误报必填）">
                <Select allowClear options={Object.entries(REASON_LABEL).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="evidenceRef" label="结果证据编号/链接（非待观察必填）">
                <Input maxLength={300} placeholder="验收单、对账单、工单或受控链接" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="note" label="结果说明" rules={[{ required: true, min: 3 }]}>
            <Input.TextArea rows={3} maxLength={1_000} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
