import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET as getPublicLabel } from "@/app/api/public/e-label/[token]/route";
import { getPublicElectronicLabel } from "@/server/modules/quality/service";

const read = (path: string) => readFileSync(path, "utf8");

describe("quality API and public electronic-label surface", () => {
  it("keeps every internal write behind a fresh session and centralized body parsing", () => {
    const protectedRoutes = [
      "src/app/api/quality/cases/route.ts",
      "src/app/api/quality/cases/[id]/route.ts",
      "src/app/api/quality/cases/[id]/actions/route.ts",
      "src/app/api/quality/actions/[id]/route.ts",
      "src/app/api/quality/regulatory/route.ts",
      "src/app/api/quality/labels/route.ts",
    ].map(read);

    for (const route of protectedRoutes) {
      if (/export async function (POST|PATCH)/.test(route)) {
        expect(route).toContain("guardFreshWrite");
        expect(route).toContain("readJson(req)");
      }
      expect(route).toContain("errorResponse");
    }

    // 不良事件案件、行动证据与监管证据即使是 GET 也必须回查数据库中的当前账号/角色，
    // 防止旧 JWT 在角色摘除后继续读取受限证据或监管载荷。
    expect(protectedRoutes[0]).toContain("guardFreshWrite");
    expect(protectedRoutes[0]).not.toContain("guardRead");
    expect(protectedRoutes[2]).toContain("guardFreshWrite");
    expect(protectedRoutes[2]).not.toContain("guardRead");
    expect(protectedRoutes[4]).toContain("guardFreshWrite");
    expect(protectedRoutes[4]).not.toContain("guardRead");
    expect(protectedRoutes[5]).toContain("guardRead");
  });

  it("exposes only the token-gated read model and makes both public paths reachable", () => {
    const publicRoute = read("src/app/api/public/e-label/[token]/route.ts");
    const page = read("src/app/e-label/[token]/page.tsx");
    const errorPage = read("src/app/e-label/[token]/error.tsx");
    const css = read("src/app/e-label/[token]/page.module.css");
    const middleware = read("src/middleware.ts");

    expect(publicRoute).toContain("getPublicElectronicLabel(token)");
    expect(publicRoute).toContain('"Cache-Control", "no-store"');
    expect(publicRoute).not.toContain("guardRead");
    expect(publicRoute).not.toContain("guardFreshWrite");
    expect(page).toContain("getPublicElectronicLabel(token)");
    expect(page).toContain("notFound()");
    expect(page).toContain("label.lifecycleState");
    expect(page).toContain('"scheduled"');
    expect(page).toContain('"historical"');
    expect(page).toContain('"blocked"');
    expect(page).toContain("label.regulatorySupportState");
    expect(page).toContain("监管支撑当前不可用");
    expect(page).toContain('role="alert"');
    expect(page).toContain("label.notice");
    expect(page).toContain("robots: { index: false, follow: false }");
    expect(errorPage).toContain("reset");
    expect(errorPage).toContain("电子标签暂时无法加载");
    expect(css).toContain(".blockedNotice");
    expect(css).toContain(".retryButton:focus-visible");
    expect(middleware).toContain('"/e-label"');
    expect(middleware).toContain("path === root || path.startsWith(`${root}/`)");
    expect(middleware).toContain("supplier/confirm(?:/|$)");
    expect(middleware).toContain("e-label(?:/|$)");
    expect(middleware).toContain("api/public(?:/|$)");
    expect(middleware).not.toContain("supplier/confirm|e-label|api/public");
  });

  it("returns a machine-readable 404 for malformed public tokens without a session", async () => {
    const response = await getPublicLabel(
      new NextRequest("http://localhost/api/public/e-label/not-a-token"),
      { params: Promise.resolve({ token: "not-a-token" }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "电子标签不存在" });
  });

  it("strips persistence identifiers and unrecognized content from the public DTO", async () => {
    const publishedAt = new Date("2026-07-29T01:02:03.000Z");
    const firstRow = [{
      id: 91,
      labelKey: "SKU-1:CN:zh-CN",
      skuCode: "SKU-1",
      skuName: "测试面霜",
      marketCode: "CN",
      locale: "zh-CN",
      version: 2,
      content: {
        schemaVersion: "cosmetics-electronic-label/v1",
        productName: "测试面霜",
        responsibleEntity: "测试企业",
        responsibleAddress: "上海市测试路 100 号",
        netContent: "50 g",
        ingredients: ["水", "甘油"],
        precautions: "仅供外用。",
        batchStatement: "批号见包装。",
        durabilityStatement: "限用日期见包装。",
        registrationRef: "国妆网备字 20260001",
        supplierCost: "should-never-leak",
      },
      contentDigest: "abc123",
      effectiveDate: "2026-07-29",
      createdAt: publishedAt,
      createdBy: 7,
      regulatoryRecordId: 23,
      publicToken: "0123456789abcdef0123456789abcdef",
    }];
    const queryResults = [
      firstRow,
      [{ version: 2 }],
    ];
    let call = 0;
    const fakeDb = {
      select: () => {
        const result = queryResults[call++];
        const builder = {
          from: () => builder,
          innerJoin: () => builder,
          where: () => builder,
          orderBy: () => builder,
          limit: () => Promise.resolve(result),
          then: (
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) => Promise.resolve(result).then(resolve, reject),
        };
        return builder;
      },
    };

    const dto = await getPublicElectronicLabel(
      "0123456789abcdef0123456789abcdef",
      fakeDb,
    );

    expect(Object.keys(dto).sort()).toEqual([
      "content",
      "digest",
      "effectiveDate",
      "isCurrent",
      "lifecycleState",
      "locale",
      "marketCode",
      "notice",
      "publishedAt",
      "regulatorySupportState",
      "schemaVersion",
      "sku",
      "version",
    ]);
    expect(Object.keys(dto.content).sort()).toEqual([
      "batchStatement",
      "durabilityStatement",
      "ingredients",
      "netContent",
      "precautions",
      "productName",
      "registrationRef",
      "responsibleAddress",
      "responsibleEntity",
    ]);
    expect(dto).not.toHaveProperty("id");
    expect(dto).not.toHaveProperty("labelKey");
    expect(dto).not.toHaveProperty("publicToken");
    expect(dto).not.toHaveProperty("regulatoryRecordId");
    expect(dto.content).not.toHaveProperty("supplierCost");
  });
});
