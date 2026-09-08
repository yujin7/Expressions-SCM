import { afterEach, expect, it, vi } from "vitest";
import { alertLookupQueries, ALERT_LOOKUP_MAX_ENCODED_KEYS, ALERT_LOOKUP_MAX_KEYS } from "@/lib/alert-lookup";
import { loadAlertLookup } from "@/components/useAlertLookup";

afterEach(() => vi.unstubAllGlobals());
const parse = (query: string) => JSON.parse(new URL(query, "http://localhost").searchParams.get("keys")!) as string[];
const reply = (query: string) => Response.json({ total: parse(query).length, unackedTotal: 999,
  rows: parse(query).map(key => ({ id: Number(key.split(":").at(-1)) + 1, dedupeKey: key, status: "open" })) });
it("deduplicates exact identities and respects both count and encoded GET-length bounds", () => {
  const keys = Array.from({ length: 250 }, (_, i) => `sales_spike:platform:店,甲|${"汉".repeat(30)}|${i}`);
  const queries = alertLookupQueries("sales_spike", [...keys, keys[0]]);
  expect(queries.length).toBeGreaterThan(3);
  expect(queries.flatMap(parse).sort()).toEqual([...keys].sort());
  for (const query of queries) {
    const raw = new URL(query, "http://localhost").searchParams.get("keys")!;
    expect(parse(query).length).toBeLessThanOrEqual(ALERT_LOOKUP_MAX_KEYS);
    expect(encodeURIComponent(raw).length).toBeLessThanOrEqual(ALERT_LOOKUP_MAX_ENCODED_KEYS);
  }
});
it("loads 450 exact identities with at most four simultaneous requests and never sums category totals", async () => {
  const waiting: { query: string; resolve: (value: Response) => void }[] = [];
  const fetch = vi.fn((query: string) => new Promise<Response>(resolve => waiting.push({ query, resolve })));
  vi.stubGlobal("fetch", fetch);
  const result = loadAlertLookup("inventory_cover", Array.from({ length: 450 }, (_, i) => `inventory_cover:${i}`), new AbortController().signal);
  expect(fetch).toHaveBeenCalledTimes(4);
  waiting[0].resolve(reply(waiting[0].query));
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(5);
  for (const item of waiting.slice(1)) item.resolve(reply(item.query));
  const data = await result;
  expect(Object.keys(data.byKey)).toHaveLength(450);
  expect(data.unacked).toBe(999);
});
it("empty identities still request an authorized category summary, while oversized identity is an explicit failure", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ rows: [], total: 0, unackedTotal: 0 })); vi.stubGlobal("fetch", fetch);
  expect(await loadAlertLookup("inventory_cover", [], new AbortController().signal)).toEqual({ byKey: {}, unacked: 0 });
  expect(parse(fetch.mock.calls[0][0])).toEqual([]);
  await expect(loadAlertLookup("sales_spike", ["中".repeat(800)], new AbortController().signal)).rejects.toThrow("过长");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  { rows: [], total: 1, unackedTotal: 1 }, { rows: [], total: 0 },
  { rows: [{ id: 1, dedupeKey: "inventory_cover:wrong", status: "open" }], total: 1, unackedTotal: 1 },
  { rows: [{ id: 1, dedupeKey: "inventory_cover:1", status: "resolved" }], total: 1, unackedTotal: 1 },
])("incomplete or unrelated responses cannot masquerade as a known index: %j", async body => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
  await expect(loadAlertLookup("inventory_cover", ["inventory_cover:1"], new AbortController().signal)).rejects.toThrow("告警关联响应");
});
it("pre-cancelled lookup does not start requests", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const controller = new AbortController(); controller.abort();
  await expect(loadAlertLookup("inventory_cover", ["inventory_cover:1"], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});
