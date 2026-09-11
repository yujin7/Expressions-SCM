import { redirect } from "next/navigation";

export const metadata = { title: "NPD 节点参考" };

/**
 * 旧路径别名：NPD 节点参考已并入 `/npd` 的「节点模板」页签。
 *
 * 并页理由：这份只读底稿（transit_refs 的 npd_node/npd_role）**就是** /npd 建项目时
 * 实例化用的模板，两者却作为两个菜单项并排挂在「新品开发」组里，
 * 且它的页签标签把条数写死成 69/19（模板重导后不会变）。现按实际行数渲染在 /npd 内。
 * 这里保留 302 跳转：收藏夹与外部文档里的 /report/npd 仍然可用。
 */
export default function Page() {
  redirect("/npd?tab=templates");
}
