import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import AntdReact19Compat from "@/components/AntdReact19Compat";
import "./globals.css";

export const metadata: Metadata = {
  title: "供应链系统",
  description: "内部供应链管理系统 — 委外闭环 MVP 1.0",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdReact19Compat />
        <AntdRegistry>
          <ConfigProvider
            locale={zhCN}
            theme={{
              token: {
                colorPrimary: "#3157d5",
                colorInfo: "#3157d5",
                colorBgLayout: "#f3f6fb",
                colorText: "#172033",
                colorTextSecondary: "#667085",
                colorBorder: "#dfe5ee",
                borderRadius: 8,
                borderRadiusLG: 12,
                controlHeight: 36,
                fontFamily:
                  "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
              },
              components: {
                Layout: { headerBg: "#ffffff", siderBg: "#0b1b36" },
                Menu: {
                  darkItemBg: "#0b1b36",
                  darkSubMenuItemBg: "#07162d",
                  darkItemSelectedBg: "#3157d5",
                  itemBorderRadius: 8,
                },
                Table: { headerBg: "#f7f9fc", headerColor: "#475467", rowHoverBg: "#f6f8ff" },
                Card: { paddingLG: 20 },
                Button: { primaryShadow: "0 4px 12px rgba(49, 87, 213, 0.2)" },
              },
            }}
          >
            {children}
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
