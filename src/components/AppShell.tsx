"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { App as AntApp, Avatar, Button, Layout, Menu, Modal, Space, Typography, theme } from "antd";
import type { MenuProps } from "antd";
import {
  AccountBookOutlined,
  ApartmentOutlined,
  BarChartOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FundOutlined,
  ImportOutlined,
  InboxOutlined,
  SettingOutlined,
  SwapOutlined,
  UserOutlined,
} from "@ant-design/icons";

import GlobalSearch from "@/components/GlobalSearch";
import CommandPalette from "@/components/CommandPalette";
import FeedbackButton from "@/components/FeedbackButton";

const { Header, Sider, Content } = Layout;

const menuItems: MenuProps["items"] = [
  { key: "/workbench", icon: <DashboardOutlined />, label: "工作台" },
  { key: "/inbox", icon: <InboxOutlined />, label: "我的待办" },
  { key: "/report/dashboard", icon: <BarChartOutlined />, label: "经营驾驶舱" },
  {
    key: "planning",
    icon: <FundOutlined />,
    label: "计划与补货",
    children: [
      { key: "/replenish", label: "补货建议" },
      { key: "/report/demand", label: "需求达成与货盘" },
      { key: "/report/risk", label: "风险库存处置" },
      { key: "/report/segmentation", label: "库存分层 ABC/XYZ" },
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
      { key: "/inventory/count", label: "盘点任务" },
      { key: "/inventory/expiry", label: "效期批次" },
      { key: "/report/sku-360", label: "SKU 360 事件轴" },
      { key: "/report/demand?tab=stock_summary", label: "总库存核对" },
      { key: "/report/jiediao", label: "借调对账" },
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
      { key: "/report/settlement-summary", label: "结算汇总表" },
      { key: "/jobs/recon", label: "对账差异" },
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
      { key: "/master/warehouse", label: "仓库" },
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
      { key: "/admin/health", label: "运维面板" },
    ],
  },
];

/**
 * RT4 UX-P0（RT5 扩展为角色映射表）：按角色过滤菜单——非本角色的入口一律不渲染。
 * 未列出的 key = 全员可见；admin 恒通过。
 */
const MENU_ROLES: Record<string, string[]> = {
  "/import/upload": ["pmc"],
  "/import/release": ["pmc"],
  "/import/jobs": ["pmc"],
  "/import/exceptions": ["pmc", "purchasing", "warehouse"],
  "/review/checklist": ["pmc", "purchasing", "warehouse", "finance"],
  "/master/feeref": ["purchasing", "pmc", "finance"],
  "/replenish": ["pmc", "purchasing"],
  "/outsource/auto-chain": ["pmc"],
  "/admin/users": [],
  "/admin/audit": ["finance"],
  "/admin/params": ["pmc", "purchasing", "finance"],
  "/settlement/js": ["finance", "purchasing"],
  "/report/settlement-summary": ["finance"],
  "/jobs/recon": ["finance", "pmc"],
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

export default function AppShell({ children, userName, roleText, roles = [], mustChangePassword = false }: { children: React.ReactNode; userName?: string; roleText?: string; roles?: string[]; mustChangePassword?: boolean }) {
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
    if (pathname.startsWith("/admin/")) return ["admin"];
    return [];
  }, [pathname]);

  const onPasswordPage = pathname.startsWith("/account/password");
  return (
    <AntApp>
      <CommandPalette />
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
            items={useMemo(() => filterMenuByRoles(menuItems, roles), [roles])}
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
              <GlobalSearch />
              <FeedbackButton />
              <Avatar size="small" icon={<UserOutlined />} />
              <Typography.Text>{userName ?? "未登录"}</Typography.Text>
              {roleText ? <Typography.Text type="secondary">（{roleText}）</Typography.Text> : null}
              <Typography.Link href="/account/password">修改密码</Typography.Link>
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
