/**
 * E1-05 主数据编码规范（纯函数）。
 *
 * 背景：主档中曾出现编码 "0" 的幽灵行——既非空又非真实编码，静默参与所有 join 与统计。
 * 标识符是全系统 join 的地基，不该允许手写体。
 *
 * 规则（拒收）：
 * - 空白、含空格/制表符；
 * - 纯数字且长度 < 4（"0"/"12" 这类占位值——真实编码如 "690001" 条码不在此列）；
 * - 长度 < 2 或 > 60；
 * - 全角字符（编码应为半角，避免视觉同形的隐性重复主档）。
 * 规则（可疑，不拒收但进健康度清单）：
 * - 纯数字（无字母前缀，与本司 E/N/DEV 前缀体系不符）；
 * - 含中文。
 */

export interface CodeVerdict {
  ok: boolean;
  /** 拒收原因（ok=false 时必有） */
  reason?: string;
  /** 可疑标记（ok=true 但值得复核） */
  suspicious?: string;
}

const FULLWIDTH = /[！-～　]/;
const HAS_CJK = /[一-鿿]/;

export function checkCode(raw: string | null | undefined): CodeVerdict {
  const code = String(raw ?? "").trim();
  if (!code) return { ok: false, reason: "编码不能为空" };
  if (/\s/.test(code)) return { ok: false, reason: "编码不能含空格" };
  // 占位值判定优先于长度——"0"/"12" 给出更有信息量的原因
  if (/^\d+$/.test(code) && code.length < 4) return { ok: false, reason: `「${code}」疑似占位值，非有效编码` };
  if (code.length < 2) return { ok: false, reason: "编码至少 2 位" };
  if (code.length > 60) return { ok: false, reason: "编码不超过 60 位" };
  if (FULLWIDTH.test(code)) return { ok: false, reason: "编码不能含全角字符（请用半角）" };

  if (/^\d+$/.test(code)) return { ok: true, suspicious: "纯数字编码（本司体系通常带字母前缀）" };
  if (HAS_CJK.test(code)) return { ok: true, suspicious: "编码含中文" };
  return { ok: true };
}

/** 批量体检：返回不合规与可疑清单 */
export function auditCodes(codes: string[]): { invalid: { code: string; reason: string }[]; suspicious: { code: string; reason: string }[] } {
  const invalid: { code: string; reason: string }[] = [];
  const suspicious: { code: string; reason: string }[] = [];
  for (const c of codes) {
    const v = checkCode(c);
    if (!v.ok) invalid.push({ code: c, reason: v.reason! });
    else if (v.suspicious) suspicious.push({ code: c, reason: v.suspicious });
  }
  return { invalid, suspicious };
}
