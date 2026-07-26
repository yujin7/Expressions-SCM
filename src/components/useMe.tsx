"use client";

import { createContext, useContext, useEffect, useState } from "react";

export interface Me {
  id: number;
  name: string;
  roles: string[];
  isApprover: boolean;
}

let cache: Me | null = null;
let inflight: Promise<Me | null> | null = null;
const MeContext = createContext<Me | null | undefined>(undefined);

async function fetchMe(): Promise<Me | null> {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) return null;
    return (await res.json()) as Me;
  } catch {
    return null;
  }
}

/** 会话内缓存的当前用户；用于按角色渲染操作按钮（服务端仍是唯一权威） */
export function useMe(): Me | null {
  const provided = useContext(MeContext);
  const [me, setMe] = useState<Me | null>(cache);
  useEffect(() => {
    if (provided !== undefined) return;
    if (cache) return;
    inflight ??= fetchMe().then((m) => {
      cache = m;
      return m;
    });
    void inflight.then((m) => setMe(m));
  }, [provided]);
  return provided === undefined ? me : provided;
}

/** Layout 注入已鉴权用户，避免每个客户端页面先空渲染再请求 /api/me。 */
export function MeProvider({ initialMe, children }: { initialMe: Me; children: React.ReactNode }) {
  return <MeContext.Provider value={initialMe}>{children}</MeContext.Provider>;
}

export function hasAnyRole(me: Me | null, ...roles: string[]): boolean {
  if (!me) return false;
  if (me.roles.includes("admin")) return true;
  return roles.some((r) => me.roles.includes(r));
}
