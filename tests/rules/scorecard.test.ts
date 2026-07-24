/** E5-06 供应商记分卡纯规则测试 */
import { describe, expect, it } from "vitest";
import {
  CONCESSION_PENALTY,
  gradeOf,
  scoreSupplier,
  SCORE_WEIGHTS,
  SCRAP_PENALTY,
  type ScoreInput,
} from "@/server/rules/scorecard";

/** 默认「满分底座」：准时 100%、合格 100%、无让步/报废、无调价、样本充足 */
const base: ScoreInput = {
  onTimeRate: 1,
  qcPassRate: 1,
  concessionRate: 0,
  scrapRate: 0,
  priceChangeCount: 0,
  sampleN: 12,
};
const inp = (o: Partial<ScoreInput>): ScoreInput => ({ ...base, ...o });
const dim = (r: ReturnType<typeof scoreSupplier>, key: string) => {
  const d = r.breakdown.find((b) => b.key === key);
  if (!d) throw new Error(`breakdown 缺少维度 ${key}`);
  return d;
};

describe("权重定义", () => {
  it("三维度权重合计 100（准时 40 / 质量 40 / 价格 20）", () => {
    expect(SCORE_WEIGHTS.onTime + SCORE_WEIGHTS.quality + SCORE_WEIGHTS.price).toBe(100);
  });
});

describe("满分场景", () => {
  it("准时 100% + 合格 100% + 无让步报废 + 无调价 → 100 分 S 级、高置信", () => {
    const r = scoreSupplier(base);
    expect(r.score).toBe(100);
    expect(r.grade).toBe("S");
    expect(r.confidence).toBe("high");
    expect(dim(r, "onTime").points).toBe(40);
    expect(dim(r, "quality").points).toBe(40);
    expect(dim(r, "price").points).toBe(20);
    // 三维度得分之和 = 综合分（无归一时）
    expect(r.breakdown.reduce((a, b) => a + (b.points ?? 0), 0)).toBe(100);
  });
});

describe("准时率拉低总分", () => {
  it("准时率 50% → 准时维度只拿一半（20/40），总分 80 降为 A 级", () => {
    const r = scoreSupplier(inp({ onTimeRate: 0.5 }));
    expect(dim(r, "onTime").points).toBe(20);
    expect(r.score).toBe(80);
    expect(r.grade).toBe("A");
  });

  it("准时率 0% → 准时维度 0 分，总分 60（仍计其余维度，不整体清零）", () => {
    const r = scoreSupplier(inp({ onTimeRate: 0 }));
    expect(dim(r, "onTime").points).toBe(0);
    expect(r.score).toBe(60);
    expect(r.grade).toBe("C");
  });
});

describe("让步/报废惩罚", () => {
  it("让步半罚：合格率 90% + 让步 10% → 质量达成率 85%（90 − 10×0.5）", () => {
    const r = scoreSupplier(inp({ qcPassRate: 0.9, concessionRate: 0.1 }));
    expect(CONCESSION_PENALTY).toBe(0.5);
    expect(dim(r, "quality").points).toBeCloseTo(0.85 * 40, 6); // 34
    expect(r.score).toBe(94); // 40 + 34 + 20
  });

  it("报废全罚：合格率 90% + 报废 10% → 质量达成率 80%（90 − 10×1.0），罚得比同比例让步更重", () => {
    const r = scoreSupplier(inp({ qcPassRate: 0.9, scrapRate: 0.1 }));
    expect(SCRAP_PENALTY).toBe(1);
    expect(dim(r, "quality").points).toBeCloseTo(0.8 * 40, 6); // 32
    expect(r.score).toBe(92);
    // 同比例下报废分数必须低于让步
    const conc = scoreSupplier(inp({ qcPassRate: 0.9, concessionRate: 0.1 }));
    expect(r.score as number).toBeLessThan(conc.score as number);
  });

  it("惩罚封底 0：合格率 50% + 让步 40% + 报废 40% 不会算出负分", () => {
    const r = scoreSupplier(inp({ qcPassRate: 0.5, concessionRate: 0.4, scrapRate: 0.4 }));
    expect(dim(r, "quality").points).toBe(0);
    expect(r.score).toBe(60); // 40（准时）+ 0（质量）+ 20（价格）
  });

  it("质量维度 note 写明惩罚构成（可解释）", () => {
    const r = scoreSupplier(inp({ qcPassRate: 0.9, concessionRate: 0.1, scrapRate: 0.02 }));
    expect(dim(r, "quality").note).toContain("让步惩罚");
    expect(dim(r, "quality").note).toContain("报废惩罚");
  });
});

describe("价格稳定", () => {
  it("变更 2 次 → 价格维度 12/20（线性递减，满 5 次归零）", () => {
    const r = scoreSupplier(inp({ priceChangeCount: 2 }));
    expect(dim(r, "price").points).toBeCloseTo(12, 6);
    expect(r.score).toBe(92);
  });
  it("变更 5 次及以上 → 价格维度 0 分，不会倒扣", () => {
    expect(dim(scoreSupplier(inp({ priceChangeCount: 5 })), "price").points).toBe(0);
    expect(dim(scoreSupplier(inp({ priceChangeCount: 99 })), "price").points).toBe(0);
    expect(scoreSupplier(inp({ priceChangeCount: 99 })).score).toBe(80);
  });
});

describe("缺数据维度按剩余权重归一（缺数据 ≠ 0 分）", () => {
  it("无承诺交期样本 → 准时维度不计分，按 60 分权重归一", () => {
    // 质量达成 80%（32/40）+ 价格满分（20/20）→ 52/60 → 86.67 → 87
    const r = scoreSupplier(inp({ onTimeRate: null, qcPassRate: 0.8 }));
    expect(dim(r, "onTime").points).toBeNull();
    expect(dim(r, "onTime").value).toBeNull();
    expect(dim(r, "onTime").note).toContain("权重已归一");
    expect(r.score).toBe(87);
    expect(r.grade).toBe("A");
    expect(r.reason).toContain("归一");
  });

  it("无检验数据 → 质量维度不计分；同样的准时率下不因缺检验而被判低分", () => {
    const r = scoreSupplier(inp({ qcPassRate: null, concessionRate: null, scrapRate: null, onTimeRate: 0.9 }));
    expect(dim(r, "quality").points).toBeNull();
    expect(dim(r, "quality").note).toContain("权重已归一");
    // (0.9×40 + 20) / 60 = 93.33 → 93
    expect(r.score).toBe(93);
    expect(r.grade).toBe("S");
  });

  it("两个维度都缺 → 只剩价格 20 分权重，仍能评级（归一后满分）", () => {
    const r = scoreSupplier(inp({ onTimeRate: null, qcPassRate: null, concessionRate: null, scrapRate: null }));
    expect(r.score).toBe(100);
    expect(r.breakdown.filter((b) => b.points == null)).toHaveLength(2);
  });
});

describe("样本不足 → 不评级", () => {
  it("样本 2 < 默认 3 → score/grade 为 null、confidence=low、reason 含「样本不足」", () => {
    const r = scoreSupplier(inp({ sampleN: 2, onTimeRate: 0 }));
    expect(r.score).toBeNull();
    expect(r.grade).toBeNull();
    expect(r.confidence).toBe("low");
    expect(r.reason).toContain("样本不足");
    // 不评级时所有维度都不给分，但仍保留原始指标与说明（供人工看数据）
    expect(r.breakdown.every((b) => b.points === null)).toBe(true);
    expect(r.breakdown.every((b) => b.note.includes("样本不足"))).toBe(true);
    expect(dim(r, "onTime").value).toBe(0);
  });

  it("零样本 → 同样不评级，而不是 0 分 D 级", () => {
    const r = scoreSupplier(inp({ sampleN: 0 }));
    expect(r.score).toBeNull();
    expect(r.grade).toBeNull();
  });

  it("minSamples 可调：样本 5 在 minSamples=8 下不评级、在默认 3 下评级", () => {
    expect(scoreSupplier(inp({ sampleN: 5 }), 8).score).toBeNull();
    expect(scoreSupplier(inp({ sampleN: 5 })).score).toBe(100);
  });

  it("置信度分档：<3 低、3~9 中、≥10 高", () => {
    expect(scoreSupplier(inp({ sampleN: 2 })).confidence).toBe("low");
    expect(scoreSupplier(inp({ sampleN: 3 })).confidence).toBe("medium");
    expect(scoreSupplier(inp({ sampleN: 9 })).confidence).toBe("medium");
    expect(scoreSupplier(inp({ sampleN: 10 })).confidence).toBe("high");
  });
});

describe("等级阈值边界（90/80/70/60）", () => {
  it("gradeOf 边界值取上档", () => {
    expect(gradeOf(100)).toBe("S");
    expect(gradeOf(90)).toBe("S");
    expect(gradeOf(89.9)).toBe("A");
    expect(gradeOf(80)).toBe("A");
    expect(gradeOf(79)).toBe("B");
    expect(gradeOf(70)).toBe("B");
    expect(gradeOf(69)).toBe("C");
    expect(gradeOf(60)).toBe("C");
    expect(gradeOf(59)).toBe("D");
    expect(gradeOf(0)).toBe("D");
  });

  it("端到端命中各档：90=S / 80=A / 70=B / 60=C / 59=D", () => {
    // 准时满分 40 + 价格满分 20 + 质量按需 → 精确落在阈值上
    const q = (qcPassRate: number) => scoreSupplier(inp({ qcPassRate }));
    expect(q(0.75).score).toBe(90);
    expect(q(0.75).grade).toBe("S");
    expect(q(0.5).score).toBe(80);
    expect(q(0.5).grade).toBe("A");
    expect(q(0.25).score).toBe(70);
    expect(q(0.25).grade).toBe("B");
    // 60：准时 50%（20）+ 质量 50%（20）+ 价格 20
    const c = scoreSupplier(inp({ onTimeRate: 0.5, qcPassRate: 0.5 }));
    expect(c.score).toBe(60);
    expect(c.grade).toBe("C");
    // 59：准时 47.5%（19）+ 质量 50%（20）+ 价格 20
    const d = scoreSupplier(inp({ onTimeRate: 0.475, qcPassRate: 0.5 }));
    expect(d.score).toBe(59);
    expect(d.grade).toBe("D");
  });
});
