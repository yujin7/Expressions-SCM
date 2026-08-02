import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routePath = path.resolve(
  __dirname,
  "../../src/app/api/admin/users/[id]/feishu-binding/route.ts",
);

describe("飞书身份绑定路由安全边界", () => {
  it("PUT/DELETE 均使用新鲜会话回查，不相信页面层角色", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain('import { getFreshSessionUser } from "@/server/core/dto"');
    expect(source.match(/await getFreshSessionUser\(\)/g)).toHaveLength(2);
    expect(source).toContain("await bindFeishuIdentity(actor");
    expect(source).toContain("await unbindFeishuIdentity(actor");
    expect(source).toContain("await readJson(req)");
  });
});
