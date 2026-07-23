/**
 * 定点小数工具——全系统禁止 float 运算（CLAUDE.md）。
 * 表示法：十进制字符串（与 drizzle numeric 一致）。内部 BigInt，缩放 1e6，半进位舍入。
 * 金额落库 scale=2，数量落库 scale=4；中间计算 scale=6。
 */
const SCALE = 6;
const POW = 10n ** BigInt(SCALE);

function toUnits(v: string | number): bigint {
  const s = typeof v === "number" ? v.toString() : v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`invalid decimal: ${v}`);
  const neg = s.startsWith("-");
  const [intPart, fracPart = ""] = (neg ? s.slice(1) : s).split(".");
  const frac = (fracPart + "0".repeat(SCALE)).slice(0, SCALE);
  // 超出 scale 的位按半进位处理
  const rest = fracPart.slice(SCALE);
  let units = BigInt(intPart) * POW + BigInt(frac || "0");
  if (rest && Number(rest[0]) >= 5) units += 1n;
  return neg ? -units : units;
}

function fromUnits(u: bigint, scale: number): string {
  const neg = u < 0n;
  const abs = neg ? -u : u;
  // 半进位舍入到目标 scale
  const drop = 10n ** BigInt(SCALE - scale);
  const rounded = (abs + drop / 2n) / drop;
  const div = 10n ** BigInt(scale);
  const intPart = rounded / div;
  const fracPart = rounded % div;
  const fracStr = scale > 0 ? "." + fracPart.toString().padStart(scale, "0") : "";
  return `${neg && rounded !== 0n ? "-" : ""}${intPart}${fracStr}`;
}

export type Dec = string | number;

export function dAdd(a: Dec, b: Dec, scale = 4): string {
  return fromUnits(toUnits(a) + toUnits(b), scale);
}
export function dSub(a: Dec, b: Dec, scale = 4): string {
  return fromUnits(toUnits(a) - toUnits(b), scale);
}
export function dMul(a: Dec, b: Dec, scale = 4): string {
  return fromUnits((toUnits(a) * toUnits(b)) / POW, scale);
}
export function dDiv(a: Dec, b: Dec, scale = 4): string {
  const bu = toUnits(b);
  if (bu === 0n) throw new Error("division by zero");
  return fromUnits((toUnits(a) * POW) / bu, scale);
}
/** 比较：a<b → -1, a==b → 0, a>b → 1 */
export function dCmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const d = toUnits(a) - toUnits(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}
export function dMax(a: Dec, b: Dec, scale = 4): string {
  return fromUnits(dCmp(a, b) >= 0 ? toUnits(a) : toUnits(b), scale);
}
export function dNeg(a: Dec, scale = 4): string {
  return fromUnits(-toUnits(a), scale);
}
export function dZero(a: Dec): boolean {
  return toUnits(a) === 0n;
}
/** 向上取整到 multiple 的整数倍（R11 订货倍数），multiple<=0 时原样返回 */
export function dCeilToMultiple(a: Dec, multiple: Dec, scale = 4): string {
  const m = toUnits(multiple);
  if (m <= 0n) return fromUnits(toUnits(a), scale);
  const u = toUnits(a);
  const q = (u + m - 1n) / m;
  return fromUnits(q * m, scale);
}
/** 金额口径（scale=2） */
export const dMoney = (a: Dec) => fromUnits(toUnits(a), 2);
/** 数量口径（scale=4） */
export const dQty = (a: Dec) => fromUnits(toUnits(a), 4);
/** 偏差百分比 (new-base)/base*100，scale=2 */
export function dDeviationPct(base: Dec, next: Dec): string {
  return dMul(dDiv(dSub(next, base, 6), base, 6), 100, 2);
}
