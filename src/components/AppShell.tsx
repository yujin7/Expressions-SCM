"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { App as AntApp, Avatar, Button, Drawer, Dropdown, Grid, Layout, Menu, Modal, Space, Typography, theme } from "antd";
import type { MenuProps } from "antd";
import {
  AccountBookOutlined,
  ApartmentOutlined,
  BarChartOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DownOutlined,
  ExperimentOutlined,
  FundOutlined,
  ImportOutlined,
  InboxOutlined,
  MenuOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  SwapOutlined,
  UserOutlined,
} from "@ant-design/icons";

import GlobalSearch from "@/components/GlobalSearch";
import CommandPalette from "@/components/CommandPalette";
import FeedbackButton from "@/components/FeedbackButton";
import { MeProvider, type Me } from "@/components/useMe";
import { buildMenuTree, routeGroupForPath, type MenuNode, type RouteGroup, type RouteKey } from "@/lib/route-access";

const { Header, Sider, Content } = Layout;

/**
 * 菜单/分组/角色可见性全部派生自 `@/lib/route-access`（D62 单一注册表）：
 * 本文件只负责图标与渲染，新增页面请到注册表登记，勿在此加硬编码条目。
 */
const GROUP_ICONS: Record<Exclude<RouteGroup, "top">, React.ReactNode> = {
  messages: <InboxOutlined />,
  analytics: <BarChartOutlined />,
  planning: <FundOutlined />,
  outsourcing: <ApartmentOutlined />,
  matflow: <SwapOutlined />,
  inventory: <InboxOutlined />,
  quality: <SafetyCertificateOutlined />,
  npd: <ExperimentOutlined />,
  finance: <AccountBookOutlined />,
  master: <DatabaseOutlined />,
  import: <ImportOutlined />,
  admin: <SettingOutlined />,
};
const TOP_ROUTE_ICONS: Partial<Record<RouteKey, React.ReactNode>> = {
  workbench: <DashboardOutlined />,
  inbox: <InboxOutlined />,
};

export function navigationGroupForPath(pathname: string): string | null {
  const registered = routeGroupForPath(pathname);
  if (registered) return registered;
  if (pathname.startsWith("/master/")) return "master";
  if (pathname.startsWith("/inventory/")) return "inventory";
  if (pathname.startsWith("/quality")) return "quality";
  if (pathname.startsWith("/outsource/")) return "outsourcing";
  if (pathname.startsWith("/matflow/")) return "matflow";
  if (pathname.startsWith("/settlement/") || pathname.startsWith("/jobs/")) return "finance";
  if (pathname.startsWith("/import/") || pathname.startsWith("/review/")) return "import";
  if (pathname.startsWith("/npd")) return "npd";
  if (pathname.startsWith("/admin/")) return "admin";
  if (pathname.startsWith("/report/")) return "analytics";
  return null;
}

export function selectedMenuKeyForPath(pathname: string): string {
  return pathname;
}

/** 注册表树 → AntD Menu items（按角色过滤已在 buildMenuTree 内完成；admin 恒通过） */
function menuItemsForRoles(roles: string[]): MenuProps["items"] {
  return buildMenuTree(roles).map((node: MenuNode) => {
    if (node.kind === "route") {
      return { key: node.key, icon: TOP_ROUTE_ICONS[node.routeKey], label: node.label };
    }
    return {
      key: node.key,
      icon: GROUP_ICONS[node.key],
      label: node.label,
      children: node.children.map((c) => ({ key: c.key, label: c.label })),
    };
  });
}

export default function AppShell({
  children,
  currentUser,
  roleText,
  mustChangePassword = false,
}: {
  children: React.ReactNode;
  currentUser: Me;
  roleText?: string;
  mustChangePassword?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { name: userName, roles } = currentUser;
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const screens = Grid.useBreakpoint();
  const isMobile = screens.lg === false;
  const isCompactHeader = screens.lg === true && screens.xl === false;
  const {
    token: { colorBgContainer },
  } = theme.useToken();

  const activeGroup = useMemo(() => navigationGroupForPath(pathname), [pathname]);
  const [openKeys, setOpenKeys] = useState<string[]>(() => (activeGroup ? [activeGroup] : []));
  const visibleMenuItems = useMemo(() => menuItemsForRoles(roles), [roles]);
  const compactAccountItems = useMemo<MenuProps["items"]>(
    () => [
      {
        key: "identity",
        label: `${userName ?? "未登录"}${roleText ? `（${roleText}）` : ""}`,
        disabled: true,
      },
      { type: "divider" },
      { key: "password", label: "修改密码" },
      { key: "signout", label: "退出登录", danger: true },
    ],
    [roleText, userName],
  );
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    if (!activeGroup) return;
    setOpenKeys((current) => (current.includes(activeGroup) ? current : [...current, activeGroup]));
  }, [activeGroup]);

  const navigationMenu = (
    <Menu
      theme="dark"
      mode="inline"
      items={visibleMenuItems}
      selectedKeys={[selectedMenuKeyForPath(pathname)]}
      openKeys={openKeys}
      onOpenChange={(keys) => setOpenKeys(keys)}
      onClick={({ key }) => {
        if (key.startsWith("/")) {
          router.push(key);
          setMobileMenuOpen(false);
        }
      }}
    />
  );

  const onPasswordPage = pathname.startsWith("/account/password");
  if (!mounted) {
    return (
      <div className="app-boot" role="status" aria-label="正在加载供应链系统">
        <div className="app-boot__sidebar">
          <div className="app-boot__brand" />
          {Array.from({ length: 9 }, (_, index) => (
            <div className="app-boot__nav" key={index} />
          ))}
        </div>
        <div className="app-boot__workspace">
          <div className="app-boot__header" />
          <div className="app-boot__surface">
            <div className="app-boot__title" />
            <div className="app-boot__line" />
            <div className="app-boot__line app-boot__line--short" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <MeProvider initialMe={currentUser}>
      <AntApp>
      <CommandPalette roles={roles} />
      <Modal
        open={mustChangePassword && !onPasswordPage}
        closable={false}
        maskClosable={false}
        keyboard={false}
        title="请先修改初始密码"
        footer={
          <Button type="primary" onClick={() => router.push("/account/password")}>
            去修改密码
          </Button>
        }
      >
        当前账号使用的是管理员设置的初始/临时密码，为保障账号安全，须修改后方可继续使用系统。
      </Modal>
      <Layout className="app-layout">
        {!isMobile ? <Sider className="app-sider" collapsible collapsed={collapsed} onCollapse={setCollapsed} width={220} theme="dark">
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
              fontSize: collapsed ? 12 : 16,
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            <span className="app-brand__mark">
              {/* eslint-disable-next-line @next/next/no-img-element -- 品牌标识为静态资源 */}
              <img src="/logo.png" alt="" aria-hidden="true" />
            </span>
            {/* 折叠时**整个不渲染**，而不是渲染空字符串：
                空 span 仍参与 flex gap，会在 logo 右侧留 10px 幻影间距，
                使其在居中容器里实际偏左。 */}
            {collapsed ? null : <span className="app-brand__name">供应链系统</span>}
          </div>
          {navigationMenu}
        </Sider> : null}
        <Drawer
          placement="left"
          width={280}
          open={isMobile && mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
          styles={{ body: { padding: 0, background: "#001529" }, header: { display: "none" } }}
          destroyOnHidden
        >
          <div
            style={{
              height: 60,
              display: "flex",
              alignItems: "center",
              padding: "0 24px",
              color: "#fff",
              fontWeight: 650,
              fontSize: 16,
              background: "#001529",
            }}
          >
            供应链系统
          </div>
          {navigationMenu}
        </Drawer>
        <Layout className="app-workspace">
          <Header
            className="app-header"
            style={{
              background: colorBgContainer,
              /* 内边距必须与下方 Content 的 margin 一致（移动端 8、其余 16）：
                 顶栏是通栏白条，内容区却是一张内缩的卡片，两者内边距不同的话
                 标题与右侧账号区就会与卡片左右边缘差几个像素——原先桌面端顶栏
                 24px、卡片 16px，正是差 8px 的来源。 */
              padding: isMobile ? "0 8px" : "0 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Space size={8} className="app-header__identity">
              {isMobile ? (
                <Button
                  type="text"
                  icon={<MenuOutlined />}
                  aria-label="打开主导航"
                  onClick={() => setMobileMenuOpen(true)}
                />
              ) : null}
              <Typography.Title level={4} style={{ margin: 0 }}>
                {isMobile ? "供应链" : "供应链系统"}
              </Typography.Title>
            </Space>
            <div className="app-header__actions">
              {!isMobile ? (
                <div className="app-header__search">
                  <GlobalSearch />
                </div>
              ) : null}
              {!isMobile ? <FeedbackButton /> : null}
              {isCompactHeader ? (
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: compactAccountItems,
                    onClick: ({ key }) => {
                      if (key === "password") router.push("/account/password");
                      if (key === "signout") router.push("/signout");
                    },
                  }}
                >
                  <Button
                    type="text"
                    className="app-header__account-menu"
                    aria-label={`打开账户菜单：${userName ?? "未登录"}`}
                    aria-haspopup="menu"
                  >
                    <Avatar size="small" icon={<UserOutlined />} />
                    <DownOutlined aria-hidden />
                  </Button>
                </Dropdown>
              ) : (
                <>
                  <Avatar size="small" icon={<UserOutlined />} />
                  {!isMobile ? (
                    <Typography.Text className="app-header__user" title={userName ?? "未登录"}>
                      {userName ?? "未登录"}
                    </Typography.Text>
                  ) : null}
                  {!isMobile && roleText ? (
                    <Typography.Text className="app-header__role" type="secondary" title={roleText}>
                      （{roleText}）
                    </Typography.Text>
                  ) : null}
                  {!isMobile ? <Typography.Link href="/account/password">修改密码</Typography.Link> : null}
                  <Typography.Link href="/signout">退出</Typography.Link>
                </>
              )}
            </div>
          </Header>
          <Content className="app-content" style={{ margin: isMobile ? 8 : 16 }}>
            <main className="app-surface" style={{ background: colorBgContainer, padding: isMobile ? 12 : 24 }}>
              {children}
            </main>
          </Content>
        </Layout>
      </Layout>
      </AntApp>
    </MeProvider>
  );
}
