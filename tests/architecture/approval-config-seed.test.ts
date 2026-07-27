import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_APPROVAL_CONFIGS as matflowConfigs } from "@/server/modules/matflow/common-notes";
import { REQUIRED_APPROVAL_CONFIGS as outsourceConfigs } from "@/server/modules/outsource/common";

describe("生产 seed 审批配置契约", () => {
  it("所有服务声明的必需审批域都存在于 approvalSeeds", () => {
    const source = readFileSync(path.join(process.cwd(), "src/db/seed.ts"), "utf8");
    for (const [docType, role] of Object.entries({ ...outsourceConfigs, ...matflowConfigs })) {
      expect(
        source,
        `seed 缺少 ${docType}→${role}，生产审批会报 NO_CONFIG`,
      ).toMatch(new RegExp(`\\[\\s*"${docType}"\\s*,\\s*"${role}"\\s*\\]`));
    }
  });
});
