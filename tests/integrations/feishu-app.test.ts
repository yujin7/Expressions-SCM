import { describe, expect, it, vi } from "vitest";
import {
  FeishuAppClient,
  feishuPermissionSetFingerprint,
  feishuWebhookUrlFromEnv,
} from "@/server/integrations/feishu";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("飞书应用机器人", () => {
  it("权限指纹忽略顺序和重复项，但等级变化会失效", () => {
    const baseline = feishuPermissionSetFingerprint([
      { scope: "im:chat:readonly", level: 1 },
      { scope: "im:message:send_as_bot", level: 1 },
    ]);
    expect(feishuPermissionSetFingerprint([
      { scope: "im:message:send_as_bot", level: 1 },
      { scope: "im:chat:readonly", level: 1 },
      { scope: "im:chat:readonly", level: 1 },
    ])).toBe(baseline);
    expect(feishuPermissionSetFingerprint([
      { scope: "im:chat:readonly", level: 2 },
      { scope: "im:message:send_as_bot", level: 1 },
    ])).not.toBe(baseline);
  });

  it("自定义机器人 webhook 只接受飞书官方精确主机和路径", () => {
    expect(feishuWebhookUrlFromEnv({
      FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
    } as unknown as NodeJS.ProcessEnv)).toBe(
      "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
    );
    for (const value of [
      "http://open.feishu.cn/open-apis/bot/v2/hook/test-token",
      "https://open.feishu.cn.evil.example/open-apis/bot/v2/hook/test-token",
      "https://open.feishu.cn/open-apis/bot/v2/hook/test-token?next=evil",
      "https://open.feishu.cn/open-apis/im/v1/messages",
    ]) {
      expect(feishuWebhookUrlFromEnv({
        FEISHU_WEBHOOK_URL: value,
      } as unknown as NodeJS.ProcessEnv)).toBeNull();
    }
  });

  it("缓存 tenant token，并用 chat_id + UUID 发送可去重文本", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("tenant_access_token")) {
        return response({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      }
      return response({ code: 0, data: { message_id: "om_1" } });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const client = new FeishuAppClient({
      appId: "cli_a",
      appSecret: "secret",
      chatId: "oc_chat",
    }, { fetchImpl, retries: 0, now: () => 1_000_000 });

    await client.sendText({ title: "异常", body: "数量变化", uuid: "notice-1" });
    await client.sendText({ title: "异常", body: "数量变化", uuid: "notice-2" });

    const tokenCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("tenant_access_token"));
    const messageCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/im/v1/messages"));
    expect(tokenCalls).toHaveLength(1);
    expect(messageCalls).toHaveLength(2);
    const [url, init] = messageCalls[0] as unknown as [string, RequestInit];
    expect(url).toContain("receive_id_type=chat_id");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tenant-token" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      receive_id: "oc_chat",
      msg_type: "text",
      uuid: "notice-1",
    });
    expect(String(init.body)).not.toContain("secret");
  });

  it("只读分页发现应用可见群，并去重排序", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("tenant_access_token")) {
        return response({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      }
      if (value.includes("page_token=next")) {
        return response({
          code: 0,
          data: {
            has_more: false,
            items: [
              { chat_id: "oc_a", name: "采购协同" },
              { chat_id: "oc_b", name: "供应链异常" },
            ],
          },
        });
      }
      return response({
        code: 0,
        data: {
          has_more: true,
          page_token: "next",
          items: [{ chat_id: "oc_b", name: "供应链异常" }],
        },
      });
    });
    const client = new FeishuAppClient(
      { appId: "cli_a", appSecret: "secret" },
      { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 },
    );

    await expect(client.listAccessibleChats()).resolves.toEqual([
      { chatId: "oc_a", name: "采购协同" },
      { chatId: "oc_b", name: "供应链异常" },
    ]);
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("tenant_access_token"))).toHaveLength(1);
  });

  it("只读检查本应用线上版本与最小权限，只返回聚合证据", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("tenant_access_token")) {
        return response({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      }
      return response({
        code: 0,
        data: {
          app: {
            app_id: "cli_must_not_escape",
            app_name: "私密应用名",
            status: 1,
            online_version_id: "oav_online",
            mobile_default_ability: "bot",
            pc_default_ability: "bot",
            scopes: [
              { scope: "application:application:self_manage", level: 1, description: "管理应用" },
              { scope: "im:chat:readonly", level: 1, description: "读取群" },
              { scope: "im:message:send_as_bot", level: 1, description: "发消息" },
            ],
          },
        },
      });
    });
    const client = new FeishuAppClient(
      { appId: "cli_a", appSecret: "secret" },
      { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 },
    );

    const result = await client.inspectSelfApplication();

    expect(result).toEqual({
      enabled: "enabled",
      onlineVersion: "present",
      botDefault: "bot_default_both",
      scopes: {
        inventory: "parsed",
        fingerprint: feishuPermissionSetFingerprint([
          { scope: "application:application:self_manage", level: 1 },
          { scope: "im:chat:readonly", level: 1 },
          { scope: "im:message:send_as_bot", level: 1 },
        ]),
        total: 3,
        elevated: 0,
        chatList: "declared",
        sendAsBot: "declared",
        outsideNotificationAllowlist: 0,
        leastPrivilege: "no_excess_detected",
      },
    });
    const [url, init] = fetchMock.mock.calls.find(([requestUrl]) =>
      String(requestUrl).includes("/application/v6/applications/me")) as unknown as [
        string,
        RequestInit,
      ];
    expect(url).toBe(
      "https://open.feishu.cn/open-apis/application/v6/applications/me?lang=zh_cn",
    );
    expect(init).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer tenant-token" },
    });
    expect(JSON.stringify(result)).not.toMatch(/cli_must_not_escape|私密应用名|tenant-token|secret/);
  });

  it("权限结构含不认识的项目时保留 unknown，不把缺失误报成未声明", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("tenant_access_token")) {
        return response({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      }
      return response({
        code: 0,
        data: {
          app: {
            online_version_id: "",
            scopes: [
              { scope: "im:message:send_as_bot", level: 1 },
              { description: "结构未知", level: 2 },
            ],
          },
        },
      });
    });
    const client = new FeishuAppClient(
      { appId: "cli_a", appSecret: "secret" },
      { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 },
    );

    await expect(client.inspectSelfApplication()).resolves.toEqual({
      enabled: "unknown",
      onlineVersion: "absent",
      botDefault: "unknown",
      scopes: {
        inventory: "ambiguous",
        fingerprint: null,
        total: 2,
        elevated: 1,
        chatList: "unknown",
        sendAsBot: "declared",
        outsideNotificationAllowlist: null,
        leastPrivilege: "unknown",
      },
    });
  });

  it("极端权限膨胀只报告总量和等级总量，不回显权限明细", async () => {
    const scopes = Array.from({ length: 1_107 }, (_, index) => ({
      description: `sensitive-description-${index}`,
      level: index < 1_007 ? 2 : 1,
      scope: index === 0
        ? "im:chat:readonly"
        : index === 1
          ? "im:message:send_as_bot"
          : index === 2
            ? "application:application:self_manage"
            : `unrelated:scope:${index}`,
      token_types: ["tenant"],
    }));
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("tenant_access_token")) {
        return response({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      }
      return response({
        code: 0,
        data: { app: { online_version_id: "oav_online", scopes } },
      });
    });
    const client = new FeishuAppClient(
      { appId: "cli_a", appSecret: "secret" },
      { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 },
    );

    const result = await client.inspectSelfApplication();

    expect(result.scopes).toEqual({
      inventory: "parsed",
      fingerprint: feishuPermissionSetFingerprint(scopes),
      total: 1_107,
      elevated: 1_007,
      chatList: "declared",
      sendAsBot: "declared",
      outsideNotificationAllowlist: 1_104,
      leastPrivilege: "extreme_over_privilege",
    });
    expect(JSON.stringify(result)).not.toContain("unrelated:scope");
    expect(JSON.stringify(result)).not.toContain("sensitive-description");
  });

  it("业务错误不回显供应商消息中的凭据或 token", async () => {
    const fetchMock = vi.fn(async () => response({
      code: 999,
      msg: "secret and tenant-token must never escape",
    }));
    const client = new FeishuAppClient(
      { appId: "cli_a", appSecret: "secret" },
      { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 },
    );

    await expect(client.inspectSelfApplication()).rejects.toThrow("飞书鉴权 999: 调用失败");
    await expect(client.inspectSelfApplication()).rejects.not.toThrow(/secret|tenant-token/);
  });

  it("未配置 chat_id 时拒绝发送，不会调用网络", async () => {
    const fetchMock = vi.fn();
    const client = new FeishuAppClient(
      { appId: "cli_a", appSecret: "secret" },
      { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 },
    );

    await expect(client.sendText({
      title: "异常",
      body: "数量变化",
      uuid: "notice-1",
    })).rejects.toThrow("未配置目标 chat_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
