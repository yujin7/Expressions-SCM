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
  {
    key: "outsourcing",
    icon: <ApartmentOutlined />,
    label: "委外（W3）",
    children: [
      { key: "/outsource/bh", label: "备货申请" },
      { key: "/outsource/wo", label: "委外工单" },
      { key: "/outsource/po", label: "采购订单" },
      { key: "/outsource/pc", label: "价格变更" },
      { key: "/outsource/jg", label: "加工通知单" },
      { key: "/matflow/fl", label: "发料单" },
      { key: "/matflow/tl", label: "退料单" },
      { key: "/matflow/sh", label: "收货检验" },
      { key: "/matflow/ct", label: "采购退货" },
      { key: "/settlement/js", label: "结算单" },
      { key: "/jobs/recon", label: "对账差异" },
    ],
  },
  {
    key: "inventory",
    icon: <InboxOutlined />,
    label: "库存（W2）",
    children: [
      { key: "/inventory/balance", label: "库存余额" },
      { key: "/inventory/ledger", label: "库存流水" },
      { key: "/inventory/docs", label: "库存单据" },
    ],
  },
  {
    key: "import",
    icon: <ImportOutlined />,
    label: "导入中心（W4）",
    children: [
      { key: "/import/jobs", label: "导入任务" },
      { key: "/import/exceptions", label: "别名认领" },
    ],
  },
  {
    key: "reports",
    icon: <BarChartOutlined />,
    label: "报表（W5）",
    children: [
      { key: "/report/wip", label: "委外在制看板" },
      { key: "/report/settlement-summary", label: "结算汇总表" },
    ],
  },
  { key: "admin", icon: <SettingOutlined />, label: "系统管理（W5）", disabled: true },
];

export default function AppShell({ children, userName, roleText }: { children: React.ReactNode; userName?: string; roleText?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const {
    token: { colorBgContainer },
  } = theme.useToken();

  const openKeys = useMemo(() => {
    if (pathname.startsWith("/master/")) return ["master"];
    if (pathname.startsWith("/inventory/")) return ["inventory"];
    if (pathname.startsWith("/outsource/")) return ["outsourcing"];
    if (pathname.startsWith("/matflow/")) return ["outsourcing"];
    if (pathname.startsWith("/settlement/")) return ["outsourcing"];
    if (pathname.startsWith("/jobs/")) return ["outsourcing"];
    if (pathname.startsWith("/import/")) return ["import"];
    if (pathname.startsWith("/report/")) return ["reports"];
    return [];
  }, [pathname]);

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
              <Typography.Link href="/signout">退出</Typography.Link>
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
