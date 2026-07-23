"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, App, Card, Col, Row, Statistic, Tooltip, Typography } from "antd";
import { AuditOutlined, SendOutlined, WarningOutlined } from "@ant-design/icons";
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

export default function WorkbenchClient() {
  const { message } = App.useApp();
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [openAliasCount, setOpenAliasCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
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
