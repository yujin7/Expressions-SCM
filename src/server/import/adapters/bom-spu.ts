/**
 * SPU 建议引擎（《04》§4.1 派生规则，R3 附则）：
 * 机器建议 = 产品族前缀（productCode 第一段，如 N006/E01/DEV025）∩ 归一化品名
 * （剥品牌 token/括号规格/版本后缀）双证一致 → confident 同 SPU；
 * 双证不一致（同族异名）或跨族同名 → needsReview（100% 异常队列人工归组，禁止自动定案）。
 * -a（升级）/-X（规格）等变体后缀默认同 SPU（00-A7 服装类比）——族前缀天然吸收。
 */
import { normalizeBomProductName, type BomBlock } from "./bom";

export interface SpuCluster {
  spuKey: string;
  suggestedName: string;
  members: string[];
  confidence: "auto" | "review";
  /** review 时的原因（同族异名 / 跨族同名） */
  reasons: string[];
}

/** productCode → 族前缀（首个 "-" 之前的段；无 "-" 则整码即族） */
export function familyPrefix(code: string): string {
  const i = code.indexOf("-");
  return (i === -1 ? code : code.slice(0, i)).toUpperCase();
}

export function suggestSpus(blocks: BomBlock[]): SpuCluster[] {
  // 每个编码取其出现过的所有归一化名（同码可能多块）
  const codeNames = new Map<string, Set<string>>();
  for (const b of blocks) {
    if (!b.productCode) continue;
    const set = codeNames.get(b.productCode) ?? new Set<string>();
    const n = normalizeBomProductName(b.productName);
    if (n) set.add(n);
    codeNames.set(b.productCode, set);
  }

  // 族 → 成员编码
  const families = new Map<string, string[]>();
  for (const code of codeNames.keys()) {
    const fam = familyPrefix(code);
    const arr = families.get(fam);
    if (arr) arr.push(code);
    else families.set(fam, [code]);
  }

  // 跨族同名检测：归一化名 → 出现的族集合
  const nameFamilies = new Map<string, Set<string>>();
  for (const [code, names] of codeNames) {
    const fam = familyPrefix(code);
    for (const n of names) {
      const set = nameFamilies.get(n) ?? new Set<string>();
      set.add(fam);
      nameFamilies.set(n, set);
    }
  }

  const clusters: SpuCluster[] = [];
  for (const [fam, codes] of families) {
    codes.sort();
    const nameSet = new Set<string>();
    for (const c of codes) for (const n of codeNames.get(c) ?? []) nameSet.add(n);
    const names = [...nameSet];
    const reasons: string[] = [];
    if (names.length > 1) reasons.push(`同族异名：${names.slice(0, 5).join(" / ")}`);
    if (names.length === 0) reasons.push("无可用品名");
    for (const n of names) {
      const fams = nameFamilies.get(n);
      if (fams && fams.size > 1) {
        reasons.push(`跨族同名「${n}」：${[...fams].sort().join("/")}`);
      }
    }
    // suggestedName：出现频次最高的归一化名（并列取字典序）
    const freq = new Map<string, number>();
    for (const c of codes) for (const n of codeNames.get(c) ?? []) freq.set(n, (freq.get(n) ?? 0) + 1);
    const suggestedName =
      [...freq.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? fam;
    clusters.push({
      spuKey: fam,
      suggestedName,
      members: codes,
      confidence: reasons.length === 0 ? "auto" : "review",
      reasons,
    });
  }
  clusters.sort((a, b) => (a.spuKey < b.spuKey ? -1 : 1));
  return clusters;
}
