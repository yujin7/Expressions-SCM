import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

export const metadata: Metadata = {
  title: "供应链系统",
  description: "内部供应链管理系统 — 委外闭环 MVP 1.0",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0 }}>
        <AntdRegistry>
          <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: "#1677ff" } }}>
            {children}
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
