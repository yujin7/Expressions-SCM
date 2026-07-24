"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Card, Col, Row, Statistic, Tooltip, Typography } from "antd";
import { AuditOutlined, RightOutlined, SendOutlined, WarningOutlined } from "@ant-design/icons";
import Link from "next/link";
import { fetchJson } from "@/components/fetchJson";

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
  const [focusLoading, setFocusLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFocusLoading(true);
    // 角色聚焦区块（服务端按当前用户角色计算真实计数）
    fetchJson<{ sections: FocusSection[] }>("/api/workbench")
      .then((r) => setSections(r.sections))
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
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        工作台
      </Typography.Title>
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
