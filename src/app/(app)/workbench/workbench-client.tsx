"use client";

import { Alert, Card, Col, Row, Statistic, Typography } from "antd";
import { AuditOutlined, SendOutlined, WarningOutlined } from "@ant-design/icons";

/** 工作台占位数据：W5 接入待办/预警真实统计 */
export default function WorkbenchClient() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        工作台
      </Typography.Title>
      <Alert
        type="info"
        showIcon
        message="MVP 1.0 建设中——本页 W5 接入真实数据"
        style={{ marginBottom: 16 }}
      />
      <Row gutter={16}>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic title="待我审批" value={0} prefix={<AuditOutlined />} suffix="单" />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic title="我发起的" value={0} prefix={<SendOutlined />} suffix="单" />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic title="预警" value={0} prefix={<WarningOutlined />} suffix="项" />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
