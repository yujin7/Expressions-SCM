"use client";

import { useEffect, useState } from "react";

export interface Me {
  id: number;
  name: string;
  roles: string[];
  isApprover: boolean;
}

let cache: Me | null = null;
let inflight: Promise<Me | null> | null = null;

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
  const [me, setMe] = useState<Me | null>(cache);
  useEffect(() => {
    if (cache) return;
    inflight ??= fetchMe().then((m) => {
      cache = m;
      return m;
    });
    void inflight.then((m) => setMe(m));
  }, []);
  return me;
}

export function hasAnyRole(me: Me | null, ...roles: string[]): boolean {
  if (!me) return false;
  if (me.roles.includes("admin")) return true;
  return roles.some((r) => me.roles.includes(r));
}
