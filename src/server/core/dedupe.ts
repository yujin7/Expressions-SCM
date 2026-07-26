/**
 * E5-09 主档去重侦测（纯函数）。
 *
 * 背景：主数据健康度扫描显示 5,376 个 SKU 中仅 281 个完全健康，且曾发现编码为 "0" 的幽灵行。
 * 「缺什么」已有健康度页回答；本模块回答另一半——**「多了什么」**：同一实物被建了多条主档
 * （同名不同码、一字之差、全半角混用、单位后缀差异），它们会让库存分散、销量割裂、补货重复。
 *
 * 算法取舍（都为中文商品名场景优化，且**都被真实数据修正过一轮**）：
 * - **归一化只统一写法、不丢信息**：全半角/大小写/括号/空白/分隔符统一，
 *   但**保留规格的值**。早期版本会整段删掉 `(110g)` 这类尾巴，结果把
 *   「清洁泥膜(110g)」和「清洁泥膜(20g)」判成同一物——不同规格被当成重复。
 * - **相似度**：先比全等（最强信号），再用 **bigram Dice 系数**——
 *   对中文比编辑距离更稳（中文单字信息量大，编辑距离对短名过于敏感）。
 * - **完全连接收簇**：簇内两两都必须达阈值。早期用并查集（单连接），
 *   在真实数据上会顺着「精华水→精华液→精华乳→面霜」一路串联，把整条产品线
 *   判成一组重复——这是本模块最危险的失效模式，务必不要改回单连接。
 * - **只产出候选，绝不自动合并**：主档合并会牵动库存/台账/BOM，必须人工裁决。
 *   输出按可疑度排序的**合并建议队列**，由人确认。
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

/**
 * 归一化：**只统一书写形式，绝不丢弃信息**。
 *
 * 这里有过一次真实数据打脸：最初版本会把 `(110g)` 这类规格尾巴整段删掉，
 * 想用它匹配「面霜(35g)」与「面霜 35g」。结果在 5,376 个真实 SKU 上，
 * 「清洁泥膜(110g)」和「清洁泥膜(20g)」被归一成同一个串——**不同规格被判成重复**。
 * 现在改为保留规格的**值**、只统一它的**写法**：全半角、大小写、括号、空白、分隔符。
 * 于是 `面霜(35g)` 与 `面霜 35g` 仍然相等，而 `面霜(35g)` 与 `面霜(100g)` 正确地不等。
 */
export function normalizeName(raw: string): string {
  let s = String(raw ?? "");
  // 全角 → 半角（含（）［］，范围 U+FF01–FF5E）
  s = s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
  s = s.toLowerCase();
  // 去掉括号本身但保留内容——括号有无不该影响判定，内容必须留着
  s = s.replace(/[()【】\[\]{}]/g, "");
  // 统一乘号写法："28ml×10片" ≡ "28ml*10片"。
  // 左侧允许字母（单位后缀 ml/g 常紧贴乘号），但**右侧必须是数字**——
  // 否则 "max强效" 里的 x 也会被替换掉。
  s = s.replace(/([0-9a-z])\s*[x×]\s*(\d)/g, "$1*$2");
  // 去空白与纯书写性分隔符（不含数字、字母、单位）
  s = s.replace(/[\s\-_/、,，.。:：;；]/g, "");
  return s.trim();
}

/**
 * 规格签名：抽出名称里所有「数字+单位」token，排序后作为**硬判别器**。
 *
 * 为什么必须硬判别而不是交给相似度：真实名称带很长的品牌前缀
 * （「(NING DERMOLOGIE)光感润白淡斑精华液(30ml)」近 30 字），
 * 10ml / 15ml / 30ml 之间只差 3 个 bigram，Dice 高达 0.9+，
 * 无论阈值调到多少都会把不同规格判成重复；而调高阈值又会漏掉真正的重复。
 * 规格不同就是不同 SKU——这是业务事实，应当一票否决，不参与打分。
 */
const SPEC_RE = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|片|支|袋|盒|粒|包|对|条|只|克|毫升|升)/g;

export function specSignature(normalized: string): string[] {
  const out: string[] = [];
  for (const m of normalized.matchAll(SPEC_RE)) out.push(`${Number(m[1])}${m[2]}`);
  return out.sort();
}

/** 规格是否冲突：两边都有规格且不一致 → 必然是不同 SKU */
function specConflict(a: string, b: string): boolean {
  const sa = specSignature(a);
  const sb = specSignature(b);
  // 一方没写规格时不下断言（可能只是名称没带规格），交给相似度判断
  if (sa.length === 0 || sb.length === 0) return false;
  return sa.join("|") !== sb.join("|");
}

/**
 * 剂型判别：化妆品名称的最后一个剂型字就是这个产品「是什么」。
 *
 * 同样是硬判别器，理由同规格：「光感润白淡斑精华液(15ml)」与「光感润白淡斑精华乳(15ml)」
 * 规格相同、28 字里只差 1 字，Dice ≥0.9，靠调阈值区分不了——但**液和乳是两种产品**。
 * 取「最后一个」而非任意一个，是因为前缀里常有干扰字
 * （「水感净澈卸妆油」含水也含油，真正的剂型是结尾的油）。
 */
const FORM_CHARS = "水液乳霜膏膜油露粉胶泥棒笔皂";

function formOf(normalized: string): string {
  for (let i = normalized.length - 1; i >= 0; i--) {
    if (FORM_CHARS.includes(normalized[i])) return normalized[i];
  }
  return "";
}

/** 剂型是否冲突：两边都识别出剂型且不同 → 不同产品 */
function formConflict(a: string, b: string): boolean {
  const fa = formOf(a);
  const fb = formOf(b);
  if (!fa || !fb) return false; // 识别不出就不下断言
  return fa !== fb;
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

/**
 * 默认阈值。**这个值是在 5,376 个真实 SKU 上校准出来的，不是拍脑袋定的。**
 * 早期用 0.85 时，中文长名一字之差（「精华水」vs「精华液」，13 字里差 1 字）就有 0.875，
 * 直接把整条产品线判成重复。改为保留规格值 + 完全连接后仍保守取 0.9。
 */
const DEFAULT_THRESHOLD = 0.9;

export interface DedupeOptions {
  /** 相似度阈值（含），默认 0.9 */
  threshold?: number;
  /** 单簇最大成员数上限（防病态数据炸开），默认 20 */
  maxClusterSize?: number;
}

/**
 * 侦测疑似重复主档。**只产出候选，不做任何合并。**
 * 复杂度：按归一化名首字分桶后两两比较——避免 O(n²) 全量比较在数千 SKU 上退化。
 */
export function detectDuplicates(skus: SkuLike[], opts: DedupeOptions = {}): DupeCluster[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxClusterSize = opts.maxClusterSize ?? 20;

  const items = skus.filter((s) => s && s.name != null);
  const norms = items.map((s) => normalizeName(s.name));
  const pairReason = new Map<string, { score: number; reason: string }>();

  // 分桶：归一化名首字（空名单独一桶）
  const buckets = new Map<string, number[]>();
  norms.forEach((n, i) => {
    const key = n.slice(0, 1) || "_";
    const arr = buckets.get(key);
    if (arr) arr.push(i); else buckets.set(key, [i]);
  });

  /** 达标对：i → 所有与之相似度达阈值的 j */
  const neighbors = new Map<number, Set<number>>();
  const link = (i: number, j: number) => {
    if (!neighbors.has(i)) neighbors.set(i, new Set());
    if (!neighbors.has(j)) neighbors.set(j, new Set());
    neighbors.get(i)!.add(j);
    neighbors.get(j)!.add(i);
  };

  for (const idxs of buckets.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const i = idxs[a], j = idxs[b];
        if (norms[i] === "" && norms[j] === "") continue; // 两个空名不算重复
        if (specConflict(norms[i], norms[j])) continue; // 规格不同 → 一票否决，不打分
        if (formConflict(norms[i], norms[j])) continue; // 剂型不同（液/乳/霜…）→ 不同产品
        const exact = norms[i] === norms[j] && norms[i] !== "";
        const score = exact ? 1 : diceSimilarity(norms[i], norms[j]);
        if (score < threshold) continue;
        link(i, j);
        const key = `${Math.min(i, j)}:${Math.max(i, j)}`;
        pairReason.set(key, {
          score,
          reason: exact ? "归一化后名称完全相同" : `名称高度相似（${(score * 100).toFixed(0)}%）`,
        });
      }
    }
  }

  /**
   * **完全连接（complete linkage）收簇**：簇内**任意两两**都必须达阈值。
   *
   * 原先用并查集（单连接）：只要 A≈B、B≈C 就把 A、C 拉进同一簇。在真实数据上这是灾难——
   * 中文长名里一字之差的相似度就有 0.87+，于是「精华水→精华液→精华乳→面霜」一路串下去，
   * 整条产品线被判成一组重复。完全连接切断了这种链式扩张：不相似的两个成员
   * 永远不会因为共同的邻居而进同一簇。
   */
  const pairKey = (i: number, j: number) => `${Math.min(i, j)}:${Math.max(i, j)}`;
  const assigned = new Set<number>();
  const groups: number[][] = [];
  // 邻居多的先做种子，倾向于先形成大而紧密的簇
  const seeds = [...neighbors.keys()].sort(
    (a, b) => (neighbors.get(b)?.size ?? 0) - (neighbors.get(a)?.size ?? 0) || a - b,
  );
  for (const seed of seeds) {
    if (assigned.has(seed)) continue;
    const group = [seed];
    // 候选按与种子的相似度降序，保证优先纳入最像的
    const cands = [...(neighbors.get(seed) ?? [])]
      .filter((c) => !assigned.has(c))
      .sort(
        (a, b) =>
          (pairReason.get(pairKey(seed, b))?.score ?? 0) - (pairReason.get(pairKey(seed, a))?.score ?? 0) || a - b,
      );
    for (const c of cands) {
      // 必须与簇内**每一个**成员都达阈值
      if (group.every((g) => pairReason.has(pairKey(g, c)))) group.push(c);
    }
    if (group.length < 2) continue;
    group.forEach((g) => assigned.add(g));
    groups.push(group);
  }

  const clusters: DupeCluster[] = [];
  for (const idxs of groups) {
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
