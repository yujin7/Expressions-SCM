"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Card, Col, List, Row, Statistic, Tag, Tooltip, Typography } from "antd";
import { AuditOutlined, RightOutlined, SendOutlined, ThunderboltOutlined, WarningOutlined } from "@ant-design/icons";
import Link from "next/link";
import { fetchJson } from "@/components/fetchJson";

interface ExceptionItem {
  key: string;
  severity: "critical" | "high" | "medium";
  title: string;
  impact: string;
  count: number;
  href: string;
}

const SEV_META: Record<string, { color: string; label: string }> = {
  critical: { color: "#cf1322", label: "紧急" },
  high: { color: "#fa8c16", label: "高" },
  medium: { color: "#faad14", label: "中" },
};

/** #6 控制塔：登录第一屏「今天最需要处理的事」，按严重度+影响排序，一键直达 */
function ControlTower({ items, loading }: { items: ExceptionItem[]; loading: boolean }) {
  if (loading) return <Card loading style={{ marginBottom: 16 }} />;
  if (items.length === 0) {
    return (
      <Alert type="success" showIcon style={{ marginBottom: 16 }} message="控制塔：当前无跨域异常——各项监控均在阈值内。" />
    );
  }
  return (
    <Card
      size="small"
      style={{ marginBottom: 16, borderColor: "#ffccc7" }}
      title={<span><ThunderboltOutlined style={{ color: "#cf1322" }} /> 控制塔 · 今天最需要处理的事（{items.length}）</span>}
    >
      <List
        dataSource={items}
        renderItem={(it) => (
          <List.Item
            actions={[<Link key="go" href={it.href}>处理 <RightOutlined /></Link>]}
          >
            <List.Item.Meta
              avatar={<Tag color={SEV_META[it.severity].color}>{SEV_META[it.severity].label}</Tag>}
              title={<Link href={it.href}>{it.title}</Link>}
              description={it.impact}
            />
          </List.Item>
        )}
      />
    </Card>
  );
}

/** 待审批单据来源：库存单据 + 委外四单（BH/WO/PO/JG），各取 status=pending 的 total */
const PENDING_LIST_APIS = [
  "/api/inventory/stock-doc",
  "/api/outsource/bh",
  "/api/outsource/wo",
  "/api/outsource/po",
  "/api/outsource/jg",
];

interface FocusMetric {
  key: string;
  label: string;
  value: number | null;
  href: string;
  suffix?: string;
}

interface FocusSection {
  role: string;
  roleLabel: string;
  metrics: FocusMetric[];
}

/** 角色聚焦区块：每个数字都是真实查询，点击直达可操作页面 */
function FocusSections({ sections, loading }: { sections: FocusSection[]; loading: boolean }) {
  if (!loading && sections.length === 0) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      {loading && sections.length === 0 && (
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          {[0, 1, 2].map((i) => (
            <Col xs={24} sm={8} key={i}>
              <Card loading />
            </Col>
          ))}
        </Row>
      )}
      {sections.map((s) => (
        <div key={s.role} style={{ marginBottom: 16 }}>
          <Typography.Title level={5} style={{ marginBottom: 12 }}>
            {s.roleLabel}关注
          </Typography.Title>
          <Row gutter={[16, 16]}>
            {s.metrics.map((m) => (
              <Col xs={12} sm={8} md={6} key={m.key}>
                <Link href={m.href}>
                  <Card hoverable size="small">
                    {m.value == null ? (
                      <Statistic title={m.label} valueRender={() => <RightOutlined />} value=" " />
                    ) : (
                      <Statistic
                        title={m.label}
                        value={m.value}
                        suffix={m.suffix}
                        valueStyle={m.value > 0 ? undefined : { color: "#999" }}
                      />
                    )}
                  </Card>
                </Link>
              </Col>
            ))}
          </Row>
        </div>
      ))}
    </div>
  );
}

export default function WorkbenchClient() {
  const { message } = App.useApp();
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [openAliasCount, setOpenAliasCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [sections, setSections] = useState<FocusSection[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [focusLoading, setFocusLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFocusLoading(true);
    // 角色聚焦区块 + 控制塔异常（服务端按当前用户角色计算真实计数）
    fetchJson<{ sections: FocusSection[]; exceptions: ExceptionItem[] }>("/api/workbench")
      .then((r) => { setSections(r.sections); setExceptions(r.exceptions ?? []); })
      .catch((e) => message.error((e as Error).message))
      .finally(() => setFocusLoading(false));
    try {
      const [totals, aliasRes] = await Promise.all([
        Promise.all(
          PENDING_LIST_APIS.map((api) =>
            fetchJson<{ total: number }>(`${api}?status=pending&page=1&pageSize=1`),
          ),
        ),
        fetchJson<{ total: number }>("/api/import/exceptions?status=open&page=1&pageSize=1"),
      ]);
      setPendingCount(totals.reduce((sum, r) => sum + r.total, 0));
      setOpenAliasCount(aliasRes.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>工作台</Typography.Title>
        <Link href="/report/digest">每日经营摘要（简报视图）→</Link>
      </div>
      <ControlTower items={exceptions} loading={focusLoading && exceptions.length === 0} />
      <FocusSections sections={sections} loading={focusLoading} />
      <Alert
        type="info"
        showIcon
        message="待审批单据与待认领别名已接入真实统计；「我发起的」按人筛选建设中"
        style={{ marginBottom: 16 }}
      />
      <Row gutter={16}>
        <Col xs={24} sm={8}>
          <Card loading={loading && pendingCount == null}>
            <Statistic
              title="待审批单据"
              value={pendingCount ?? 0}
              prefix={<AuditOutlined />}
              suffix="单"
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title={<Tooltip title="按人筛选建设中">我发起的</Tooltip>}
              value={0}
              prefix={<SendOutlined />}
              suffix="单"
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Link href="/import/exceptions">
            <Card hoverable loading={loading && openAliasCount == null}>
              <Statistic
                title="待认领别名"
                value={openAliasCount ?? 0}
                prefix={<WarningOutlined />}
                suffix="项"
              />
            </Card>
          </Link>
        </Col>
      </Row>
    </div>
  );
}
