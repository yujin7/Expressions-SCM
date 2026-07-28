"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Progress,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import { CheckCircleOutlined, ExperimentOutlined, ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { fetchJson } from "@/components/fetchJson";

interface BatchRolloutReport {
  enabled: boolean;
  generatedAt: string;
  positiveQty: number;
  traceableBatchQty: number;
  legacyQty: number;
  orphanBatchQty: number;
  coveragePct: number;
  batchPairs: number;
  legacyPairs: number;
  orphanBatchPairs: number;
  expiredLots: number;
  expiredQty: number;
  openLegacyOutboundLines: number;
  managedReceiptLinesMissingBatch: number;
  outboundPaths: { key: string; label: string; covered: boolean }[];
  canEnable: boolean;
  warnings: string[];
  snapshotToken: string;
}

export function BatchPostingRolloutCard({
  canWrite,
  onActivated,
}: {
  canWrite: boolean;
  onActivated: () => void;
}) {
  const { message, modal } = App.useApp();
  const [report, setReport] = useState<BatchRolloutReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [activating, setActivating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await fetchJson<BatchRolloutReport>("/api/admin/batch-posting"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const activate = () => {
    if (!report || report.enabled || !canWrite) return;
    modal.confirm({
      title: "确认一次性启用批次过账与 FEFO？",
      width: 620,
      okText: "确认启用",
      cancelText: "取消",
      okButtonProps: { danger: report.warnings.length > 0 },
      content: (
        <Space direction="vertical" size={12} style={{ width: "100%", marginTop: 12 }}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            启用后，新收货将按批次记账，所有出库路径将在建单时按 FEFO 分配批次。
            这是单向切换，不能作为普通参数直接关闭。
          </Typography.Paragraph>
          {report.legacyQty > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`仍有 ${report.legacyQty.toLocaleString("zh-CN")} 件历史无批次库存`}
              description="它们会通过迁移期回落继续可用，但无法进入批次追溯。确认启用即表示接受这项限制。"
            />
          ) : null}
          {report.orphanBatchPairs > 0 ? (
            <Alert
              type="error"
              showIcon
              message="存在失联批次余额，当前不可启用"
              description={`${report.orphanBatchPairs} 条余额引用不存在的批次主档，共 ${report.orphanBatchQty.toLocaleString("zh-CN")} 件。`}
            />
          ) : null}
        </Space>
      ),
      onOk: async () => {
        setActivating(true);
        try {
          const result = await fetchJson<{ enabled: true; idempotent: boolean }>("/api/admin/batch-posting", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              snapshotToken: report.snapshotToken,
              confirmation: report.legacyQty > 0 ? "ENABLE_FEFO_WITH_LEGACY_FALLBACK" : undefined,
            }),
          });
          message.success(result.idempotent ? "批次过账已经启用" : "批次过账与 FEFO 已启用");
          await load();
          onActivated();
        } catch (error) {
          message.error((error as Error).message);
          throw error;
        } finally {
          setActivating(false);
        }
      },
    });
  };

  const status = report?.enabled ? (
    <Tag color="success" icon={<CheckCircleOutlined />}>已启用</Tag>
  ) : (
    <Tag color="gold" icon={<ExperimentOutlined />}>待上线体检</Tag>
  );

  return (
    <Card
      title={
        <Space>
          <SafetyCertificateOutlined />
          <span>批次过账与 FEFO 上线闸门</span>
          {status}
        </Space>
      }
      loading={loading && !report}
      style={{ marginBottom: 16 }}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新体检
          </Button>
          {canWrite && !report?.enabled ? (
            <Button
              type="primary"
              disabled={!report?.canEnable}
              loading={activating}
              onClick={activate}
            >
              审阅并启用
            </Button>
          ) : null}
        </Space>
      }
    >
      {report ? (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            type={report.enabled ? "success" : "info"}
            showIcon
            message={
              report.enabled
                ? "批次维度已成为新收货与新出库的正式记账口径"
                : "当前仍按原无批次口径过账；体检和确认不会改动库存"
            }
            description="切换后草稿单仍需正常提交与审批；FEFO 只负责建议和分配，不绕过审批、非负库存或过期批次拦截。"
          />
          <Row gutter={[10, 10]} className="compact-kpi-row">
            <Col xs={24} sm={12} lg={6}>
              <Statistic title="批次可追溯覆盖" value={report.coveragePct} suffix="%" />
              <Progress percent={report.coveragePct} showInfo={false} status={report.coveragePct < 80 ? "exception" : "normal"} />
            </Col>
            <Col xs={12} sm={6} lg={4}>
              <Statistic title="批次库存" value={report.traceableBatchQty} precision={2} />
            </Col>
            <Col xs={12} sm={6} lg={4}>
              <Statistic title="历史无批次" value={report.legacyQty} precision={2} />
            </Col>
            <Col xs={12} sm={6} lg={4}>
              <Statistic title="过期正库存批次" value={report.expiredLots} valueStyle={{ color: report.expiredLots ? "#cf1322" : undefined }} />
            </Col>
            <Col xs={12} sm={6} lg={6}>
              <Statistic title="在途旧口径出库行" value={report.openLegacyOutboundLines} valueStyle={{ color: report.openLegacyOutboundLines ? "#d46b08" : undefined }} />
            </Col>
          </Row>
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} bordered>
            {report.outboundPaths.map((path) => (
              <Descriptions.Item key={path.key} label={path.label}>
                <Tag color={path.covered ? "success" : "error"}>
                  {path.covered ? "已接入" : "未接入"}
                </Tag>
              </Descriptions.Item>
            ))}
          </Descriptions>
          {report.warnings.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message="上线前需知"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {report.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              }
            />
          ) : (
            <Alert type="success" showIcon message="当前体检未发现迁移警告" />
          )}
        </Space>
      ) : null}
    </Card>
  );
}
