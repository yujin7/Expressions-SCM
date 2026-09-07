import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { approvalConfigs, bhDocs, boms, channels, jgDocs, jsDocs, pcDocs, skus, spus, suppliers, userDataScopes, users, woDocs } from "@/db/schema";
import { searchAll } from "@/server/modules/inbox/search";
import { getBh, listBhs } from "@/server/modules/outsource/bh";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";
import { getInbox } from "@/server/modules/inbox/service";
import { GET as searchRoute } from "@/app/api/search/route";
import { GET as detailRoute } from "@/app/api/outsource/bh/[id]/route";
import { GET as listRoute } from "@/app/api/outsource/bh/route";

let routeDb: TestDb;
let routeActor: SessionUser;
vi.mock("@/db", () => ({ getDbAsync: async () => routeDb }));
vi.mock("@/server/core/dto", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/core/dto")>(), getSessionUser: async () => routeActor,
}));

describe("BH navigation uses the same visibility as its list", () => {
  let db: TestDb;
  let viewer: SessionUser;
  let hiddenId: number;
  beforeAll(async () => {
    ({ db } = await createTestDb()); routeDb = db;
    const [own, peer, foreign] = await db.insert(users).values([
      { name: "本渠道", roles: ["ops"] }, { name: "同渠道", roles: ["ops"] }, { name: "其他渠道", roles: ["ops"] },
    ]).returning();
    const [channel] = await db.insert(channels).values({ code: "SCOPE-A", name: "范围A", kind: "platform" }).returning();
    await db.insert(userDataScopes).values([
      { userId: own.id, scopeKind: "channel", targetId: channel.id, createdBy: own.id },
      { userId: peer.id, scopeKind: "channel", targetId: channel.id, createdBy: own.id },
    ]);
    // Hidden matches sort first and exceed the cap; filtering after LIMIT would lose allowed results.
    await db.insert(bhDocs).values([0, 1, 2, 3].map(i => ({ docNo: `BH-SCOPE-0${i}`, createdBy: foreign.id })));
    const [hidden] = await db.insert(bhDocs).values({ docNo: "BH-SCOPE-HIDDEN", createdBy: foreign.id }).returning();
    hiddenId = hidden.id;
    await db.insert(bhDocs).values([
      { docNo: "BH-SCOPE-OWN", createdBy: own.id, status: "pending" }, { docNo: "BH-SCOPE-PEER", createdBy: peer.id, status: "pending" },
    ]);
    viewer = { id: own.id, name: own.name, roles: ["ops"], isApprover: false, channelScope: [channel.id] };
    routeActor = viewer;
    await db.insert(bhDocs).values({ docNo: "BH-PENDING-HIDDEN", createdBy: foreign.id, status: "pending" });
    await db.insert(approvalConfigs).values([
      { docType: "bh", approverRole: "pmc" }, { docType: "pc", approverRole: "pmc" }, { docType: "js", approverRole: "finance" },
    ]);
    await db.insert(pcDocs).values({ docNo: "PC-SCOPE-PRIVATE", createdBy: own.id, status: "pending", target: "jg_fee", oldPrice: "1", newPrice: "2", deviationPct: "100", scope: "unreceived_only" });
    const [spu] = await db.insert(spus).values({ code: "SCOPE-SPU", nameCn: "范围测试产品" }).returning();
    const [sku] = await db.insert(skus).values({ code: "SCOPE-SKU", name: "范围测试产品", spuId: spu.id, skuType: "finished", baseUom: "盒" }).returning();
    const [supplier] = await db.insert(suppliers).values({ code: "SCOPE-SUP", name: "范围测试工厂", kinds: ["processor"] }).returning();
    const [bom] = await db.insert(boms).values({ productSkuId: sku.id, versionNo: "1" }).returning();
    const [wo] = await db.insert(woDocs).values({ docNo: "WO-SCOPE", createdBy: foreign.id, productSkuId: sku.id, qty: "1", supplierId: supplier.id, feeRatePlan: "1", bomId: bom.id }).returning();
    const [jg] = await db.insert(jgDocs).values({ docNo: "JG-SCOPE", createdBy: foreign.id, woId: wo.id, productSkuId: sku.id, qty: "1", supplierId: supplier.id, feeRateCurrent: "1" }).returning();
    await db.insert(jsDocs).values({ docNo: "JS-SCOPE-PRIVATE", createdBy: foreign.id, status: "pending", jgId: jg.id, goodQty: "1", feePayable: "1", settleAmount: "1" });
  });
  it("search returns own/shared-channel rows before applying its result cap", async () => {
    const result = await searchAll("BH-SCOPE", db, viewer);
    expect(result.groups.find(g => g.title === "单据")?.items.map(i => i.label)).toEqual(["BH-SCOPE-OWN", "BH-SCOPE-PEER"]);
    expect((await listBhs("BH-SCOPE", { page: 1, pageSize: 20 }, db, viewer)).total).toBe(2);
  });
  it("typing a hidden exact number cannot reveal it", async () => {
    expect((await searchAll("BH-SCOPE-HIDDEN", db, viewer)).groups).toEqual([]);
  });
  it("opening a guessed hidden ID is refused without returning the document", async () => {
    await expect(getBh(hiddenId, db, viewer)).rejects.toMatchObject({ status: 404 });
  });
  it("admin retains access even if its scope array is empty", async () => {
    const admin = { ...viewer, roles: ["admin"], channelScope: [] };
    expect((await searchAll("BH-SCOPE-HIDDEN", db, admin)).groups[0].items[0].label).toBe("BH-SCOPE-HIDDEN");
    expect((await getBh(hiddenId, db, admin)).id).toBe(hiddenId);
  });
  it("an explicit empty scope allows only the user's own documents", async () => {
    const result = await searchAll("BH-SCOPE", db, { ...viewer, channelScope: [] });
    expect(result.groups.find(g => g.title === "单据")?.items.map(i => i.label)).toEqual(["BH-SCOPE-OWN"]);
  });
  it("HTTP search and detail both forward the real session scope", async () => {
    const response = await searchRoute(new NextRequest("http://localhost/api/search?q=BH-SCOPE-HIDDEN"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ groups: [] });
    const list = await listRoute(new NextRequest("http://localhost/api/outsource/bh?q=BH-SCOPE&page=1&pageSize=20"));
    expect(list.status).toBe(200);
    expect((await list.json()).total).toBe(2);
    const detail = await detailRoute(new NextRequest(`http://localhost/api/outsource/bh/${hiddenId}`), { params: Promise.resolve({ id: String(hiddenId) }) });
    expect(detail.status).toBe(404);
    expect(JSON.stringify(await detail.json())).not.toContain("BH-SCOPE-HIDDEN");
  });
  it("scoped approvers receive only shared-channel pending BH, keeping maker-checker separation", async () => {
    const inbox = await getInbox({ ...viewer, roles: ["pmc"], isApprover: true }, db);
    expect(inbox.pending.map(i => i.docNo)).toEqual(["BH-SCOPE-PEER"]);
    expect(inbox.submitted.map(i => i.docNo)).toEqual(["BH-SCOPE-OWN"]);
  });
  it("search omits destinations denied to scoped users without changing unscoped access", async () => {
    expect((await searchAll("PC-SCOPE", db, viewer)).groups).toEqual([]);
    expect((await searchAll("PC-SCOPE", db, { ...viewer, channelScope: null })).groups[0].items[0].label).toBe("PC-SCOPE-PRIVATE");
  });
  it("a scoped submitter cannot recover denied price-change metadata through inbox", async () => {
    const scoped = await getInbox(viewer, db);
    expect(scoped.submitted.map(i => i.docNo)).toEqual(["BH-SCOPE-OWN"]);
    const unrestricted = await getInbox({ ...viewer, channelScope: null }, db);
    expect(unrestricted.submitted.map(i => i.docNo)).toContain("PC-SCOPE-PRIVATE");
  });
  it("settlement search requires the destination role as well as unrestricted scope", async () => {
    expect((await searchAll("JS-SCOPE", db, { ...viewer, channelScope: null })).groups).toEqual([]);
    const finance = { ...viewer, roles: ["finance"], isApprover: true, channelScope: null };
    expect((await searchAll("JS-SCOPE", db, finance)).groups[0].items[0].label).toBe("JS-SCOPE-PRIVATE");
    expect((await getInbox(finance, db)).pending.map(i => i.docNo)).toContain("JS-SCOPE-PRIVATE");
    expect((await getInbox({ ...finance, channelScope: viewer.channelScope }, db)).pending).toEqual([]);
  });
});
