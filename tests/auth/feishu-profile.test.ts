import { describe, expect, it, vi } from "vitest";

// config.ts 同时定义 Auth.js providers；本组只验证无网络、无数据库的纯映射契约。
vi.mock("next-auth", () => ({
  CredentialsSignin: class extends Error {
    code = "";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (config: unknown) => config }));

import { FEISHU_OAUTH_ENDPOINTS, mapFeishuProfile } from "@/server/auth/config";

describe("Feishu OAuth profile contract", () => {
  it("uses the canonical authorization, token, and user-info endpoints", () => {
    expect(FEISHU_OAUTH_ENDPOINTS).toEqual({
      authorization: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
      token: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      userinfo: "https://open.feishu.cn/open-apis/authen/v1/user_info",
    });
  });

  it("maps the documented v1 user_info data envelope", () => {
    expect(
      mapFeishuProfile({
        code: 0,
        msg: "success",
        data: {
          union_id: "on_documented_user",
          name: "张三",
          avatar_url: "https://example.test/avatar.png",
        },
      }),
    ).toEqual({
      id: "on_documented_user",
      name: "张三",
      image: "https://example.test/avatar.png",
    });
  });

  it("keeps compatibility with clients that unwrap the data envelope", () => {
    expect(
      mapFeishuProfile({
        union_id: "on_unwrapped_user",
        name: "李四",
        avatar_url: "https://example.test/avatar-2.png",
      }),
    ).toEqual({
      id: "on_unwrapped_user",
      name: "李四",
      image: "https://example.test/avatar-2.png",
    });
  });

  it("fails closed when the identity field is absent", () => {
    expect(mapFeishuProfile({ code: 0, data: {} })).toEqual({
      id: "",
      name: "飞书用户",
      image: null,
    });
  });
});
