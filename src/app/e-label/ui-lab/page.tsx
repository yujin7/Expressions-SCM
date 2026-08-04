"use client";

/* TEMP — 仅用于本机测量表头对齐，验证后删除 */
import { App as AntApp, Avatar, Button, Dropdown, Layout, Menu, Space, Typography, theme } from "antd";
import { DownOutlined, UserOutlined } from "@ant-design/icons";
import GlobalSearch from "@/components/GlobalSearch";
import FeedbackButton from "@/components/FeedbackButton";

const { Header, Sider, Content } = Layout;

export default function UiLab() {
  const { token: { colorBgContainer } } = theme.useToken();
  return (
    <AntApp>
      <Layout className="app-layout">
        <Sider className="app-sider" width={220} theme="dark">
          <div
            className="app-brand"
            style={{
              height: 48,
              margin: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 600,
              fontSize: 16,
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            <span className="app-brand__mark">
              {/* eslint-disable-next-line @next/next/no-img-element -- 临时测量页 */}
              <img src="/logo.png" alt="" aria-hidden="true" />
            </span>
            <span className="app-brand__name">供应链系统</span>
          </div>
          <Menu
            theme="dark"
            mode="inline"
            items={[
              { key: "1", label: "工作台" },
              { key: "2", label: "主数据" },
            ]}
          />
        </Sider>
        <Layout className="app-workspace">
          <Header
            className="app-header"
            style={{
              background: colorBgContainer,
              padding: "0 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Space size={8} className="app-header__identity">
              <Typography.Title level={4} style={{ margin: 0 }}>供应链系统</Typography.Title>
            </Space>
            <div className="app-header__actions">
              <div className="app-header__search">
                <GlobalSearch />
              </div>
              <FeedbackButton />
              <Dropdown trigger={["click"]} menu={{ items: [{ key: "a", label: "修改密码" }] }}>
                <Button type="text" className="app-header__account-menu" aria-label="打开账户菜单">
                  <Avatar size="small" icon={<UserOutlined />} />
                  <DownOutlined aria-hidden />
                </Button>
              </Dropdown>
            </div>
          </Header>
        </Layout>
      </Layout>
    </AntApp>
  );
}
