import { redirect } from "next/navigation";

export const metadata = { title: "交期学习" };

/**
 * 旧路径别名：交期学习已并入供应商记分卡第六页签（三套交期口径并排对照，见 leadtime-learning-tab.tsx）。
 * 这里保留 302 跳转——收藏夹、工作台旧链接、外部文档里的 /report/leadtime-learning 仍然可用。
 */
export default function Page() {
  redirect("/report/supplier-scorecard?tab=leadtime");
}
