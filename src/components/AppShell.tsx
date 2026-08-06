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

const { Header, Sider, Content } = Layout;

const REPORT_GROUPS: Record<string, string> = {
  "/replenish": "planning",
  "/replenish/versions": "planning",
  "/replenish/sop": "planning",
  "/report/dashboard": "analytics",
  "/report/decision-studio": "analytics",
  "/report/sales-bridge": "analytics",
  "/report/funnel": "analytics",
  "/report/inventory-analytics": "analytics",
  "/report/process-mining": "analytics",
  "/report/demand": "planning",
  "/report/risk": "planning",
  "/report/segmentation": "planning",
  "/report/closed-loop": "planning",
  "/report/auto-replenish": "planning",
  "/report/material-demand": "planning",
  "/report/transfer-suggest": "planning",
  "/report/leadtime-learning": "planning",
  "/report/forecast-accuracy": "planning",
  "/report/detectors": "planning",
  "/report/wip": "outsourcing",
  "/report/transit": "outsourcing",
  "/report/supplier-scorecard": "outsourcing",
  "/report/price-compare": "outsourcing",
  "/report/inbound-calendar": "inventory",
  "/report/sku-360": "inventory",
  "/report/jiediao": "inventory",
  "/report/npd": "npd",
  "/report/margin": "finance",
  "/report/settlement-summary": "finance",
  "/report/data-health": "master",
  "/report/exports": "import",
};

export function navigationGroupForPath(pathname: string): string | null {
  if (REPORT_GROUPS[pathname]) return REPORT_GROUPS[pathname];
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

const menuItems: MenuProps["items"] = [
  { key: "/workbench", icon: <DashboardOutlined />, label: "工作台" },
  { key: "/inbox", icon: <InboxOutlined />, label: "我的待办" },
  {
    key: "messages",
    icon: <InboxOutlined />,
    label: "消息与告警",
    children: [
      { key: "/notifications", label: "通知中心" },
      { key: "/alerts", label: "系统告警" },
    ],
  },
  {
    key: "analytics",
    icon: <BarChartOutlined />,
    label: "经营分析",
    children: [
      { key: "/report/dashboard", label: "经营驾驶舱" },
      { key: "/report/decision-studio", label: "决策工作室" },
      { key: "/report/sales-bridge", label: "销量变化归因" },
      { key: "/report/funnel", label: "全链达成漏斗" },
      { key: "/report/inventory-analytics", label: "库存分析" },
      { key: "/report/process-mining", label: "流程效率与瓶颈" },
    ],
  },
  {
    key: "planning",
    icon: <FundOutlined />,
    label: "计划与补货",
    children: [
      { key: "/replenish", label: "补货建议" },
      { key: "/replenish/versions", label: "计划版本与周差异" },
      { key: "/replenish/sop", label: "S&OP 计划周期" },
      { key: "/report/demand", label: "需求达成与货盘" },
      { key: "/report/risk", label: "风险库存处置" },
      { key: "/report/segmentation", label: "库存分层 ABC/XYZ" },
      { key: "/report/closed-loop", label: "建议闭环追踪" },
      { key: "/report/auto-replenish", label: "自动补货候选" },
      { key: "/report/material-demand", label: "物料需求展开 MRP" },
      { key: "/report/transfer-suggest", label: "调拨建议" },
      { key: "/report/leadtime-learning", label: "交期学习" },
      { key: "/report/forecast-accuracy", label: "预测复盘" },
      { key: "/report/detectors", label: "异动侦测" },
      { key: "/outsource/auto-chain", label: "自动链预演" },
    ],
  },
  {
    key: "outsourcing",
    icon: <ApartmentOutlined />,
    label: "委外生产",
    children: [
      { key: "/outsource/bh", label: "备货申请" },
      { key: "/outsource/wo", label: "委外工单" },
      { key: "/outsource/po", label: "采购订单" },
      { key: "/outsource/pc", label: "价格变更" },
      { key: "/outsource/jg", label: "加工通知单" },
      { key: "/report/wip", label: "委外在制看板" },
      { key: "/report/transit", label: "在途参考" },
      { key: "/report/supplier-scorecard", label: "供应商记分卡" },
      { key: "/report/price-compare", label: "物料比价" },
    ],
  },
  {
    key: "matflow",
    icon: <SwapOutlined />,
    label: "物料收发",
    children: [
      { key: "/matflow/fl", label: "发料单" },
      { key: "/matflow/tl", label: "退料单" },
      { key: "/matflow/sh", label: "收货检验" },
      { key: "/matflow/ct", label: "采购退货" },
    ],
  },
  {
    key: "inventory",
    icon: <InboxOutlined />,
    label: "库存",
    children: [
      { key: "/inventory/balance", label: "库存余额" },
      { key: "/inventory/ledger", label: "库存流水" },
      { key: "/inventory/docs", label: "库存单据" },
      { key: "/inventory/locations", label: "库位作业" },
      { key: "/inventory/count", label: "盘点任务" },
      { key: "/inventory/expiry", label: "效期批次" },
      { key: "/inventory/batch-trace", label: "批次追溯" },
      { key: "/report/inbound-calendar", label: "到货日历" },
      { key: "/report/sku-360", label: "SKU 360 事件轴" },
      { key: "/report/demand?tab=stock_summary", label: "总库存核对" },
      { key: "/report/jiediao", label: "借调对账" },
    ],
  },
  {
    key: "quality",
    icon: <SafetyCertificateOutlined />,
    label: "质量与合规",
    children: [
      { key: "/quality", label: "质量与合规" },
    ],
  },
  {
    key: "npd",
    icon: <ExperimentOutlined />,
    label: "新品开发",
    children: [
      { key: "/npd", label: "NPD 项目跟踪" },
      { key: "/report/npd", label: "NPD 节点参考" },
    ],
  },
  {
    key: "finance",
    icon: <AccountBookOutlined />,
    label: "财务结算",
    children: [
      { key: "/settlement/js", label: "结算单" },
      { key: "/report/margin", label: "毛利视角" },
      { key: "/report/settlement-summary", label: "结算汇总表" },
      { key: "/jobs/recon", label: "对账差异" },
      { key: "/settlement/month-close", label: "月结控制台" },
    ],
  },
  {
    key: "master",
    icon: <DatabaseOutlined />,
    label: "主数据",
    children: [
      { key: "/master/spu", label: "SPU 产品" },
      { key: "/master/sku", label: "SKU 货品" },
      { key: "/master/category", label: "分类" },
      { key: "/master/supplier", label: "供应商" },
      { key: "/master/supplier/lifecycle", label: "供应商准入与整改" },
      { key: "/master/warehouse", label: "仓库" },
      { key: "/master/bin", label: "库位" },
      { key: "/master/bom", label: "BOM" },
      { key: "/master/feeref", label: "加工费参考价" },
      { key: "/report/data-health", label: "主数据健康度" },
    ],
  },
  {
    key: "import",
    icon: <ImportOutlined />,
    label: "数据中心",
    children: [
      { key: "/import/upload", label: "文件上传" },
      { key: "/import/release", label: "导入放行" },
      { key: "/import/jobs", label: "导入任务" },
      { key: "/import/exceptions", label: "编码别名认领" },
      { key: "/review/checklist", label: "复核清单与提醒" },
      { key: "/report/exports", label: "导出任务" },
    ],
  },
  {
    key: "admin",
    icon: <SettingOutlined />,
    label: "系统管理",
    children: [
      { key: "/admin/users", label: "用户管理" },
      { key: "/admin/audit", label: "审计日志" },
      { key: "/admin/params", label: "运行参数" },
      { key: "/admin/approval-config", label: "审批节点配置" },
      { key: "/admin/health", label: "运维面板" },
    ],
  },
];

/**
 * RT4 UX-P0（RT5 扩展为角色映射表）：按角色过滤菜单——非本角色的入口一律不渲染。
 * 未列出的 key = 全员可见；admin 恒通过。
 */
const MENU_ROLES: Record<string, string[]> = {
  "/import/upload": ["pmc", "finance"],
  "/import/release": ["pmc", "finance"],
  "/import/jobs": ["pmc", "finance"],
  "/import/exceptions": ["pmc", "purchasing", "warehouse"],
  "/review/checklist": ["pmc", "purchasing", "warehouse", "finance"],
  "/master/feeref": ["purchasing", "pmc", "finance"],
  "/master/supplier/lifecycle": ["purchasing", "pmc", "finance"],
  "/master/bin": ["warehouse"],
  "/inventory/locations": ["warehouse"],
  "/quality": ["quality", "purchasing", "warehouse", "pmc", "ops"],
  "/replenish": ["pmc", "purchasing"],
  "/replenish/versions": ["pmc", "purchasing"],
  "/replenish/sop": ["pmc", "purchasing", "ops", "finance"],
  "/outsource/auto-chain": ["pmc"],
  "/admin/users": [],
  "/admin/audit": ["finance"],
  "/admin/params": ["pmc", "purchasing", "finance"],
  // 空数组=仅管理员（同 /admin/users）：这是 maker-checker 闸本身的配置
  "/admin/approval-config": [],
  "/settlement/js": ["finance", "purchasing"],
  "/report/settlement-summary": ["finance"],
  "/report/process-mining": ["pmc", "finance"],
  "/jobs/recon": ["finance", "pmc"],
  "/settlement/month-close": ["finance", "pmc"],
};

function filterMenuByRoles(items: MenuProps["items"], roles: string[]): MenuProps["items"] {
  const isAdmin = roles.includes("admin");
  const visible = (key: string): boolean => {
    if (isAdmin) return true;
    const need = MENU_ROLES[key];
    if (need === undefined) return true;
    return need.some((r) => roles.includes(r));
  };
  return (items ?? [])
    .map((item) => {
      if (!item) return item;
      const it = item as { key?: string; children?: { key: string; label: string }[] };
      if (it.children) {
        const children = it.children.filter((c) => visible(c.key));
        if (children.length === 0) return null;
        return { ...item, children };
      }
      return visible(String(it.key ?? "")) ? item : null;
    })
    .filter(Boolean) as MenuProps["items"];
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
  const visibleMenuItems = useMemo(() => filterMenuByRoles(menuItems, roles), [roles]);
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
