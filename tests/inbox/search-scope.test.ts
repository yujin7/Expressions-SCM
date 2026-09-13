import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { approvalConfigs, bhDocs, bhLines, boms, channels, jgDocs, jsDocs, pcDocs, skus, spus, suppliers, userDataScopes, users, woDocs } from "@/db/schema";
import { searchAll } from "@/server/modules/inbox/search";
import { getBh, listBhs } from "@/server/modules/outsource/bh";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";
import { getInbox } from "@/server/modules/inbox/service";
import { GET as searchRoute } from "@/app/api/search/route";
import { GET as detailRoute } from "@/app/api/outsource/bh/[id]/route";
import { GET as listRoute } from "@/app/api/outsource/bh/route";
import { GET as briefRoute } from "@/app/api/inbox/approval-brief/route";
import { GET as chainRoute } from "@/app/api/outsource/chain/route";
import { GET as duplicateRoute } from "@/app/api/outsource/duplicate-check/route";
import { getApprovalBrief } from "@/server/modules/inbox/approval-brief";
import { getChain } from "@/server/modules/outsource/chain";
import { GET as jsDetailRoute } from "@/app/api/settlement/js/[id]/route";
import { GET as jsListRoute } from "@/app/api/settlement/js/route";
import { GET as jsPreviewRoute } from "@/app/api/settlement/js/preview/route";
import { GET as jsBasisRoute } from "@/app/api/settlement/js/[id]/basis/route";
import { canReadSettlement } from "@/server/modules/settlement/read-access";

let routeDb: TestDb;
let routeActor: SessionUser;
vi.mock("@/db", () => ({ getDbAsync: async () => routeDb }));
vi.mock("@/server/core/dto", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/core/dto")>(), getSessionUser: async () => routeActor,
  getFreshSessionUser: async () => routeActor,
}));

describe("BH navigation uses the same visibility as its list", () => {
  let db: TestDb;
  let viewer: SessionUser;
  let hiddenId: number;
  let ownId: number;
  let skuId: number;
  let woId: number;
  let jsId: number;
  let jgId: number;
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
    const [ownBh] = await db.insert(bhDocs).values([
      { docNo: "BH-SCOPE-OWN", createdBy: own.id, status: "pending" }, { docNo: "BH-SCOPE-PEER", createdBy: peer.id, status: "pending" },
    ]).returning();
    ownId = ownBh.id;
    viewer = { id: own.id, name: own.name, roles: ["ops"], isApprover: false, channelScope: [channel.id] };
    routeActor = viewer;
    await db.insert(bhDocs).values({ docNo: "BH-PENDING-HIDDEN", createdBy: foreign.id, status: "pending" });
    await db.insert(approvalConfigs).values([
      { docType: "bh", approverRole: "pmc" }, { docType: "pc", approverRole: "pmc" }, { docType: "js", approverRole: "finance" },
    ]);
    await db.insert(pcDocs).values({ docNo: "PC-SCOPE-PRIVATE", createdBy: own.id, status: "pending", target: "jg_fee", oldPrice: "1", newPrice: "2", deviationPct: "100", scope: "unreceived_only" });
    const [spu] = await db.insert(spus).values({ code: "SCOPE-SPU", nameCn: "范围测试产品" }).returning();
    const [sku] = await db.insert(skus).values({ code: "SCOPE-SKU", name: "范围测试产品", spuId: spu.id, skuType: "finished", baseUom: "盒" }).returning();
    skuId = sku.id;
    await db.insert(bhLines).values([{ bhId: hiddenId, skuId, qty: "99" }, { bhId: ownId, skuId, qty: "1" }]);
    const [supplier] = await db.insert(suppliers).values({ code: "SCOPE-SUP", name: "范围测试工厂", kinds: ["processor"] }).returning();
    const [bom] = await db.insert(boms).values({ productSkuId: sku.id, versionNo: "1" }).returning();
    const [wo] = await db.insert(woDocs).values({ docNo: "WO-SCOPE", bhId: hiddenId, createdBy: foreign.id, productSkuId: sku.id, qty: "1", supplierId: supplier.id, feeRatePlan: "1", bomId: bom.id }).returning();
    woId = wo.id;
    const [jg] = await db.insert(jgDocs).values({ docNo: "JG-SCOPE", createdBy: foreign.id, woId: wo.id, productSkuId: sku.id, qty: "1", supplierId: supplier.id, feeRateCurrent: "1" }).returning();
    jgId = jg.id;
    const [js] = await db.insert(jsDocs).values({ docNo: "JS-SCOPE-PRIVATE", createdBy: foreign.id, status: "pending", jgId: jg.id, goodQty: "1", feePayable: "1", settleAmount: "1" }).returning();
    jsId = js.id;
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
  it("BH selected-option hydration intersects visibility, status and search instead of bypassing them", async () => {
    const query = new URLSearchParams({ selectedValues: JSON.stringify([ownId, hiddenId]), status: "pending", page: "99", pageSize: "1" });
    const response = await listRoute(new NextRequest(`http://localhost/api/outsource/bh?${query}`));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.total).toBe(1);
    expect(data.rows.map((r: { id: number }) => r.id)).toEqual([ownId]);
    for (const filter of [{ status: "approved" }, { q: "BH-SCOPE-HIDDEN" }, { selectedValues: "[]" }]) {
      const params = new URLSearchParams(query);
      for (const [key, value] of Object.entries(filter)) params.set(key, value);
      const result = await listRoute(new NextRequest(`http://localhost/api/outsource/bh?${params}`));
      expect(await result.json()).toEqual({ rows: [], total: 0 });
    }
    query.set("selectedValues", JSON.stringify(["BH-SCOPE-OWN"]));
    expect((await (await listRoute(new NextRequest(`http://localhost/api/outsource/bh?${query}`))).json()).total).toBe(1);
  });
  it("BH selector pages beyond fifty and hydrates an older exact selection without scanning", async () => {
    const inserted = await db.insert(bhDocs).values(Array.from({ length: 61 }, (_, i) => ({
      docNo: `BH-OPTIONS-${String(i).padStart(3, "0")}`, createdBy: viewer.id, status: "approved" as const,
    }))).returning({ id: bhDocs.id });
    const query = new URLSearchParams({ q: "BH-OPTIONS", status: "approved", pageSize: "50", page: "1" });
    const first = await (await listRoute(new NextRequest(`http://localhost/api/outsource/bh?${query}`))).json();
    query.set("page", "2");
    const second = await (await listRoute(new NextRequest(`http://localhost/api/outsource/bh?${query}`))).json();
    expect([first.total, second.total, first.rows.length, second.rows.length]).toEqual([61, 61, 50, 11]);
    expect(new Set([...first.rows, ...second.rows].map((r: { id: number }) => r.id)).size).toBe(61);
    expect(first.rows.some((r: { id: number }) => r.id === inserted[0].id)).toBe(false);
    query.set("selectedValues", JSON.stringify([inserted[0].id]));
    const hydrated = await (await listRoute(new NextRequest(`http://localhost/api/outsource/bh?${query}`))).json();
    expect(hydrated.total).toBe(1);
    expect(hydrated.rows.map((r: { id: number }) => r.id)).toEqual([inserted[0].id]);
  });
  it.each(["no-json", "[-1]", JSON.stringify(Array.from({ length: 51 }, (_, i) => i + 1))])("BH selector rejects malformed selection %s", async selectedValues => {
    const query = new URLSearchParams({ selectedValues });
    expect((await listRoute(new NextRequest(`http://localhost/api/outsource/bh?${query}`))).status).toBe(400);
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
  it("HTTP brief and chain cannot recover a hidden BH through auxiliary endpoints", async () => {
    const brief = await briefRoute(new NextRequest(`http://localhost/api/inbox/approval-brief?docType=bh&docId=${hiddenId}`));
    const chain = await chainRoute(new NextRequest(`http://localhost/api/outsource/chain?docType=bh&id=${hiddenId}`));
    expect(brief.status).toBe(404);
    expect(chain.status).toBe(404);
    expect(JSON.stringify([await brief.json(), await chain.json()])).not.toContain("BH-SCOPE-HIDDEN");
  });
  it("duplicate hints do not leak other-channel BH numbers or quantities", async () => {
    const response = await duplicateRoute(new NextRequest(`http://localhost/api/outsource/duplicate-check?skuIds=${skuId}`));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.hitsBySku[skuId].map((h: { docNo: string }) => h.docNo)).toEqual(["BH-SCOPE-OWN", "WO-SCOPE"]);
    expect(data.scopeNote).toContain("可见单据");
    expect(JSON.stringify(data)).not.toContain("BH-SCOPE-HIDDEN");
  });
  it("a public WO chain hides its restricted BH parent and inaccessible settlement nodes", async () => {
    const response = await chainRoute(new NextRequest(`http://localhost/api/outsource/chain?docType=wo&id=${woId}`));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.nodes.map((n: { docType: string }) => n.docType)).toEqual(["wo", "jg"]);
  });
  it("allowed brief preserves useful facts while omitting hidden duplicate identities", async () => {
    const brief = await getApprovalBrief("bh", ownId, db, viewer);
    expect(brief.docNo).toBe("BH-SCOPE-OWN");
    expect(brief.lines[0].docQty).toBe(1);
    expect(brief.lines[0].recentOrders.map(o => o.docNo)).toEqual(["WO-SCOPE"]);
    expect(brief.scopeNote).toContain("可见单据");
    expect(JSON.stringify(brief)).not.toContain("BH-SCOPE-HIDDEN");
  });
  it("admin can still inspect hidden BH brief and all related chain nodes", async () => {
    const admin = { ...viewer, roles: ["admin"], channelScope: [] };
    expect((await getApprovalBrief("bh", hiddenId, db, admin)).docNo).toBe("BH-SCOPE-HIDDEN");
    expect((await getChain({ docType: "bh", id: hiddenId }, db, admin)).nodes.map(n => n.docType)).toEqual(["bh", "wo", "jg", "js"]);
  });
  it("explicit empty scope stays own-only in auxiliary routes and malformed IDs are rejected", async () => {
    await expect(getApprovalBrief("bh", hiddenId, db, { ...viewer, channelScope: [] })).rejects.toMatchObject({ status: 404 });
    await expect(getChain({ docType: "bh", id: hiddenId }, db, { ...viewer, channelScope: [] })).rejects.toMatchObject({ status: 404 });
    const response = await briefRoute(new NextRequest("http://localhost/api/inbox/approval-brief?docType=bh&docId=nope"));
    expect(response.status).toBe(400);
  });

  async function jsReads() {
    const detail = await jsDetailRoute(new NextRequest(`http://localhost/api/settlement/js/${jsId}`), { params: Promise.resolve({ id: String(jsId) }) });
    const list = await jsListRoute(new NextRequest("http://localhost/api/settlement/js?q=JS-SCOPE"));
    const chain = await chainRoute(new NextRequest(`http://localhost/api/outsource/chain?docType=js&id=${jsId}`));
    const search = await searchRoute(new NextRequest("http://localhost/api/search?q=JS-SCOPE"));
    const inbox = await getInbox(routeActor, db);
    return { detail, list, chain, search: await search.json(), inbox };
  }

  it.each(["pmc", "purchasing", "finance"])("%s has consistent settlement detail/list/search/chain access", async role => {
    routeActor = { ...viewer, roles: [role], channelScope: null, isApprover: true };
    try {
      const r = await jsReads();
      expect([r.detail.status, r.list.status, r.chain.status]).toEqual([200, 200, 200]);
      expect((await r.detail.json()).docNo).toBe("JS-SCOPE-PRIVATE");
      expect((await r.list.json()).total).toBe(1);
      expect((await r.chain.json()).nodes.some((n: { current: boolean; id: number }) => n.current && n.id === jsId)).toBe(true);
      expect(r.search.groups[0].items[0].label).toBe("JS-SCOPE-PRIVATE");
    } finally { routeActor = viewer; }
  });

  it.each(["ops", "warehouse", "quality"])("%s read access follows current checker configuration without granting money", async role => {
    routeActor = { ...viewer, roles: [role], channelScope: null, isApprover: true };
    try {
      const denied = await jsReads();
      expect([denied.detail.status, denied.list.status, denied.chain.status]).toEqual([403, 403, 404]);
      expect(denied.search.groups).toEqual([]);
      expect(denied.inbox.pending.some(i => i.docNo === "JS-SCOPE-PRIVATE")).toBe(false);
      await db.update(approvalConfigs).set({ approverRole: role }).where(eq(approvalConfigs.docType, "js"));
      const allowed = await jsReads();
      expect([allowed.detail.status, allowed.list.status, allowed.chain.status]).toEqual([200, 200, 200]);
      const detail = await allowed.detail.json();
      expect(detail.actions).toMatchObject({ approve: false, reject: true });
      expect(detail).not.toHaveProperty("settleAmount");
      expect((await allowed.list.json()).rows[0]).not.toHaveProperty("feePayable");
      expect(allowed.inbox.pending.some(i => i.docNo === "JS-SCOPE-PRIVATE")).toBe(true);
      expect(allowed.search.groups[0].items[0].label).toBe("JS-SCOPE-PRIVATE");
      expect((await allowed.chain.json()).nodes.some((n: { current: boolean }) => n.current)).toBe(true);
      expect((await jsPreviewRoute(new NextRequest(`http://localhost/api/settlement/js/preview?jgId=${jgId}`))).status).toBe(403);
      const basis = await jsBasisRoute(new NextRequest(`http://localhost/api/settlement/js/${jsId}/basis`), { params: Promise.resolve({ id: String(jsId) }) });
      expect(basis.status).toBe(403);
      expect(JSON.stringify(await basis.json())).not.toMatch(/basisToken|settleAmount|deductPrice/);
      routeActor = { ...routeActor, isApprover: false };
      expect((await jsReads()).detail.status).toBe(403);
      routeActor = { ...routeActor, isApprover: true, channelScope: [] };
      const scoped = await jsReads();
      expect([scoped.detail.status, scoped.list.status, scoped.chain.status]).toEqual([403, 403, 404]);
      expect(scoped.search.groups).toEqual([]);
      expect(scoped.inbox.pending.some(i => i.docNo === "JS-SCOPE-PRIVATE")).toBe(false);
    } finally {
      await db.update(approvalConfigs).set({ approverRole: "finance" }).where(eq(approvalConfigs.docType, "js"));
      routeActor = viewer;
    }
  });

  it("explicit scope denies even financial readers; admin remains the existing exception", async () => {
    expect(canReadSettlement({ roles: ["finance"], channelScope: [] }, "finance")).toBe(false);
    expect(canReadSettlement({ roles: ["admin"], channelScope: [] }, null)).toBe(true);
    expect(canReadSettlement({ roles: ["warehouse"], isApprover: true }, null)).toBe(false);
    routeActor = { ...viewer, roles: ["finance"] };
    try {
      const r = await jsReads();
      expect([r.detail.status, r.list.status, r.chain.status]).toEqual([403, 403, 404]);
      expect((await jsPreviewRoute(new NextRequest(`http://localhost/api/settlement/js/preview?jgId=${jgId}`))).status).toBe(403);
      expect((await jsBasisRoute(new NextRequest(`http://localhost/api/settlement/js/${jsId}/basis`), { params: Promise.resolve({ id: String(jsId) }) })).status).toBe(403);
    } finally { routeActor = viewer; }
  });
  it.each(["bad", "0", "-1", "", "1.5"])("invalid JG filter %s must not silently return an unfiltered settlement list", async value => {
    routeActor = { ...viewer, roles: ["finance"], channelScope: null };
    try {
      const r = await jsListRoute(new NextRequest(`http://localhost/api/settlement/js?jgId=${encodeURIComponent(value)}`));
      expect(r.status).toBe(400);
      expect(JSON.stringify(await r.json())).not.toContain("JS-SCOPE-PRIVATE");
    } finally { routeActor = viewer; }
  });
});
