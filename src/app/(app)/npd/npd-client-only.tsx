"use client";

/**
 * NPD 工作区的客户端边界：AntD 重组件走 ssr:false 动态加载。
 *
 * W2：新增「节点模板」页签——它原本是独立路由 `/report/npd`「NPD 节点参考」，
 * 与本页并排挂在「新品开发」菜单组里，而它正是本页建项目时实例化用的那套模板。
 * 页签写进 URL（`?tab=templates`），旧路径 302 跳到这里。
 */
import dynamic from "next/dynamic";
import { Tabs, Typography } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

function ProjectsLoading() {
  return <div role="status" style={{ padding: 24 }}>正在加载 NPD 项目…</div>;
}

function TemplatesLoading() {
  return <div role="status" style={{ padding: 24 }}>正在加载节点模板…</div>;
}

const NpdProjectsClient = dynamic(() => import("./npd-projects-client"), {
  ssr: false,
  loading: ProjectsLoading,
});

const NodeTemplateTab = dynamic(() => import("./node-template-tab"), {
  ssr: false,
  loading: TemplatesLoading,
});

export default function NpdClientOnly() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") === "templates" ? "templates" : "projects";
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "templates") params.set("tab", "templates");
    else params.delete("tab");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>新品开发（NPD）</Typography.Title>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: "projects", label: "项目跟踪", children: <NpdProjectsClient /> },
          { key: "templates", label: "节点模板", children: <NodeTemplateTab /> },
        ]}
      />
    </div>
  );
}
