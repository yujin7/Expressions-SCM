import { Suspense } from "react";
import { redirect } from "next/navigation";
import { todoItemHref } from "@/lib/todo-navigation";
import TodoClient from "./todo-client";

export const metadata = { title: "待办任务" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  // Old notifications (including already-delivered Feishu messages) contain
  // only mine_q=#ID. Preserve all explicit user filters and normal search URLs.
  const legacy = query.mine_q;
  if (Object.keys(query).length === 1 && typeof legacy === "string" && /^#[1-9]\d*$/.test(legacy)) {
    const id = Number(legacy.slice(1));
    if (Number.isSafeInteger(id)) redirect(todoItemHref(id));
  }
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><TodoClient /></Suspense>;
}
