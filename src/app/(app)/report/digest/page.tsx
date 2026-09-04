import { redirect } from "next/navigation";

export const metadata = { title: "每日经营摘要" };

/**
 * 旧路径别名：每日经营摘要已并入工作台的「简报视图」（`/workbench?view=digest`）。
 *
 * 并页理由：本页与工作台控制塔渲染的是**同一份** `workbench/focus.ts` 例外
 * （`report/digest.ts` 自己写着"纯装配 getWorkbenchFocus 输出，不新增任何 DB 查询"）。
 * 两个菜单项、两个"登录第一屏"，同一批事实换个排版——人得先挑今天看哪一个。
 * 这里保留 302 跳转：收藏夹、旧通知链接与外部文档里的 /report/digest 仍然可用。
 */
export default function Page() {
  redirect("/workbench?view=digest");
}
