import type { SalesSpikeReadModel, SpikeHit } from "@/server/modules/report/sales-spike";

/** 爆单读模型的服务端 q 筛选（纯函数）；hitCount / unmappedCount 永远是筛选前的读模型全量（审计 #3）。 */
export type SalesSpikePage = SalesSpikeReadModel & { hitCount: number; unmappedCount: number; q: string };

export function filterSpikeHits(hits: SpikeHit[], q: string): SpikeHit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return hits;
  return hits.filter((h) =>
    (h.code ?? "").toLowerCase().includes(needle)
    || (h.name ?? "").toLowerCase().includes(needle)
    || (h.platformSkuId ?? "").toLowerCase().includes(needle)
    || h.shopName.toLowerCase().includes(needle),
  );
}

export function pageSalesSpike(model: SalesSpikeReadModel, q: string): SalesSpikePage {
  return {
    ...model,
    hits: filterSpikeHits(model.hits, q),
    unmappedHits: filterSpikeHits(model.unmappedHits, q),
    hitCount: model.hits.length,
    unmappedCount: model.unmappedHits.length,
    q: q.trim(),
  };
}
