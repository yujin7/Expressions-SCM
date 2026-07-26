import ExportsClient from "./exports-client";

export const metadata = { title: "导出任务" };

/** 异步导出任务（所有角色可用：只看得到自己的任务；admin 可见全部） */
export default function Page() {
  return <ExportsClient />;
}
