"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { App as AntApp, Avatar, Layout, Menu, Space, Typography, theme } from "antd";
import type { MenuProps } from "antd";
import {
  ApartmentOutlined,
  BarChartOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ImportOutlined,
  InboxOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons";

const { Header, Sider, Content } = Layout;

const menuItems: MenuProps["items"] = [
  { key: "/workbench", icon: <DashboardOutlined />, label: "工作台" },
  {
    key: "master",
    icon: <DatabaseOutlined />,
    label: "主数据",
    children: [
      { key: "/master/spu", label: "SPU 产品" },
      { key: "/master/sku", label: "SKU 货品" },
      { key: "/master/category", label: "分类" },
      { key: "/master/supplier", label: "供应商" },
      { key: "/master/warehouse", label: "仓库" },
      { key: "/master/bom", label: "BOM" },
    ],
  },
  { key: "outsourcing", icon: <ApartmentOutlined />, label: "委外（W3）", disabled: true },
  { key: "inventory", icon: <InboxOutlined />, label: "库存（W2）", disabled: true },
  { key: "import", icon: <ImportOutlined />, label: "导入中心（W4）", disabled: true },
  { key: "reports", icon: <BarChartOutlined />, label: "报表（W5）", disabled: true },
  { key: "admin", icon: <SettingOutlined />, label: "系统管理（W5）", disabled: true },
];

export default function AppShell({ children, userName, roleText }: { children: React.ReactNode; userName?: string; roleText?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const {
    token: { colorBgContainer },
  } = theme.useToken();

  const openKeys = useMemo(() => (pathname.startsWith("/master/") ? ["master"] : []), [pathname]);

  return (
    <AntApp>
      <Layout style={{ minHeight: "100vh" }}>
        <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} width={220} theme="dark">
          <div
            style={{
              height: 48,
              margin: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 600,
              fontSize: collapsed ? 12 : 16,
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            {collapsed ? "供应链" : "供应链系统"}
          </div>
          <Menu
            theme="dark"
            mode="inline"
            items={menuItems}
            selectedKeys={[pathname]}
            defaultOpenKeys={openKeys}
            onClick={({ key }) => {
              if (key.startsWith("/")) router.push(key);
            }}
          />
        </Sider>
        <Layout>
          <Header
            style={{
              background: colorBgContainer,
              padding: "0 24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Typography.Title level={4} style={{ margin: 0 }}>
              供应链系统
            </Typography.Title>
            <Space>
              <Avatar size="small" icon={<UserOutlined />} />
              <Typography.Text>{userName ?? "未登录"}</Typography.Text>
              {roleText ? <Typography.Text type="secondary">（{roleText}）</Typography.Text> : null}
              <Typography.Link href="/api/auth/signout">退出</Typography.Link>
            </Space>
          </Header>
          <Content style={{ margin: 16 }}>
            <div style={{ background: colorBgContainer, borderRadius: 8, padding: 24, minHeight: "100%" }}>
              {children}
            </div>
          </Content>
        </Layout>
      </Layout>
    </AntApp>
  );
}
