/** Exact ordering for decimal DTOs without importing server modules into client bundles.
 * Missing values have an explicit position; they are never coerced to zero.
 */
export function compareDecimalValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  nulls: "first" | "last" = "last",
): number {
  if (a == null || b == null) {
    if (a == null && b == null) return 0;
    return (a == null ? 1 : -1) * (nulls === "last" ? 1 : -1);
  }
  const parse = (value: string | number) => {
    const s = String(value).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error("Invalid decimal sort value");
    const negative = s.startsWith("-");
    const [whole, fraction = ""] = (negative ? s.slice(1) : s).split(".");
    return { negative, whole, fraction };
  };
  const left = parse(a), right = parse(b);
  const scale = Math.max(left.fraction.length, right.fraction.length);
  const units = (v: ReturnType<typeof parse>) => BigInt(v.whole + v.fraction.padEnd(scale, "0")) * (v.negative ? -1n : 1n);
  const diff = units(left) - units(right);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}
