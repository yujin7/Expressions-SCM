import { Card, Skeleton, Space } from "antd";

export default function Loading() {
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Skeleton.Input active size="small" />
      <Card>
        <Skeleton active paragraph={{ rows: 8 }} />
      </Card>
    </Space>
  );
}
