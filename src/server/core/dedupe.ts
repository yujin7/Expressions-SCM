/**
 * E5-09 主档去重侦测（纯函数）。
 *
 * 背景：主数据健康度扫描显示 5,376 个 SKU 中仅 281 个完全健康，且曾发现编码为 "0" 的幽灵行。
 * 「缺什么」已有健康度页回答；本模块回答另一半——**「多了什么」**：同一实物被建了多条主档
 * （同名不同码、一字之差、全半角混用、单位后缀差异），它们会让库存分散、销量割裂、补货重复。
 *
 * 算法取舍（都为中文商品名场景优化）：
 * - **归一化**：去空白/全角转半角/统一括号/剥离常见规格后缀（(35g)、*15片、25ml 等），
 *   因为"面霜(35g)"与"面霜 35g"几乎必然是同一物。
 * - **相似度**：归一化后先比全等（最强信号），再用 **bigram Dice 系数**——
 *   对中文比编辑距离更稳（中文单字信息量大，编辑距离对短名过于敏感）。
 * - **只产出候选，绝不自动合并**：主档合并会牵动库存/台账/BOM，必须人工裁决。
 *   输出按可疑度排序的**合并建议队列**，由人确认。
 * - 分组用**并查集**：A≈B、B≈C 时归为一簇，避免同一实物散在多个两两对里。
 *
 * 本文件不依赖任何项目模块，可独立测试。
 */

export interface SkuLike {
  skuId: number;
  code: string;
  name: string;
  /** 品牌名（可选）——跨品牌同名通常不是重复，用于降权 */
  brand?: string | null;
}

export interface DupeCluster {
  /** 簇内 SKU（按 skuId 升序，第一个作为建议保留项——通常是最早建档的） */
  members: SkuLike[];
  /** 簇内最高相似度 */
  topScore: number;
  /** 命中原因（供人工判断） */
  reasons: string[];
  /** 是否跨品牌（跨品牌需更谨慎，可能是正常的同名不同品） */
  crossBrand: boolean;
}

/** 全角转半角 + 去空白 + 统一括号 */
export function normalizeName(raw: string): string {
  let s = String(raw ?? "");
  // 全角 → 半角
  s = s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
  s = s.replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"));
  s = s.replace(/[【】\[\]]/g, "");
  s = s.toLowerCase();
  // 剥离常见规格尾巴：(35g) 25ml *15片 x2 等
  s = s.replace(/\(([\d.]+\s*(g|ml|kg|l|片|支|袋|盒|粒|包)[^)]*)\)/g, "");
  s = s.replace(/[*x×]\s*\d+\s*(片|支|袋|盒|粒|包)?/g, "");
  s = s.replace(/[\d.]+\s*(g|ml|kg|l)\b/g, "");
  // 去所有空白与常见分隔符
  s = s.replace(/[\s\-_/、,，.。]/g, "");
  return s.trim();
}

/** bigram 集合（长度<2 时退化为单字集合） */
function bigrams(s: string): Set<string> {
  if (s.length < 2) return new Set(s ? [s] : []);
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Dice 系数：2|A∩B| / (|A|+|B|)，范围 0~1 */
export function diceSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

class UnionFind {
  private parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number {
    while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

export interface DedupeOptions {
  /** 相似度阈值（含），默认 0.85——中文名下这个值已相当保守 */
  threshold?: number;
  /** 单簇最大成员数上限（防病态数据炸开），默认 20 */
  maxClusterSize?: number;
}

/**
 * 侦测疑似重复主档。**只产出候选，不做任何合并。**
 * 复杂度：按归一化名首字分桶后两两比较——避免 O(n²) 全量比较在数千 SKU 上退化。
 */
export function detectDuplicates(skus: SkuLike[], opts: DedupeOptions = {}): DupeCluster[] {
  const threshold = opts.threshold ?? 0.85;
  const maxClusterSize = opts.maxClusterSize ?? 20;

  const items = skus.filter((s) => s && s.name != null);
  const norms = items.map((s) => normalizeName(s.name));
  const uf = new UnionFind(items.length);
  const pairReason = new Map<string, { score: number; reason: string }>();

  // 分桶：归一化名首字（空名单独一桶）
  const buckets = new Map<string, number[]>();
  norms.forEach((n, i) => {
    const key = n.slice(0, 1) || "_";
    const arr = buckets.get(key);
    if (arr) arr.push(i); else buckets.set(key, [i]);
  });

  for (const idxs of buckets.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const i = idxs[a], j = idxs[b];
        if (norms[i] === "" && norms[j] === "") continue; // 两个空名不算重复
        const exact = norms[i] === norms[j] && norms[i] !== "";
        const score = exact ? 1 : diceSimilarity(norms[i], norms[j]);
        if (score < threshold) continue;
        uf.union(i, j);
        const key = `${Math.min(i, j)}:${Math.max(i, j)}`;
        pairReason.set(key, {
          score,
          reason: exact ? "归一化后名称完全相同" : `名称高度相似（${(score * 100).toFixed(0)}%）`,
        });
      }
    }
  }

  // 收簇
  const groups = new Map<number, number[]>();
  items.forEach((_, i) => {
    const r = uf.find(i);
    const arr = groups.get(r);
    if (arr) arr.push(i); else groups.set(r, [i]);
  });

  const clusters: DupeCluster[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    if (idxs.length > maxClusterSize) continue; // 病态簇跳过并由调用方另行提示
    const members = idxs.map((i) => items[i]).sort((x, y) => x.skuId - y.skuId);
    let topScore = 0;
    const reasons = new Set<string>();
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const key = `${Math.min(idxs[a], idxs[b])}:${Math.max(idxs[a], idxs[b])}`;
        const hit = pairReason.get(key);
        if (hit) { topScore = Math.max(topScore, hit.score); reasons.add(hit.reason); }
      }
    }
    const brands = new Set(members.map((m) => (m.brand ?? "").trim()).filter(Boolean));
    clusters.push({
      members,
      topScore: Math.round(topScore * 1000) / 1000,
      reasons: [...reasons],
      crossBrand: brands.size > 1,
    });
  }

  // 同品牌优先（更可能是真重复）、再按相似度、再按簇大小
  return clusters.sort(
    (a, b) => Number(a.crossBrand) - Number(b.crossBrand) || b.topScore - a.topScore || b.members.length - a.members.length,
  );
}
