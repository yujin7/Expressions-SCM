export interface ScanMatch<T> {
  kind: "match";
  item: T;
}

export interface ScanMiss {
  kind: "missing";
}

export interface ScanAmbiguous {
  kind: "ambiguous";
  count: number;
}

export type ScanResult<T> = ScanMatch<T> | ScanMiss | ScanAmbiguous;

export function normalizeScanCode(value: string): string {
  return value.trim().toLocaleUpperCase();
}

export function findUniqueScanMatch<T>(
  items: readonly T[],
  rawCode: string,
  getCodes: (item: T) => ReadonlyArray<string | null | undefined>,
): ScanResult<T> {
  const code = normalizeScanCode(rawCode);
  if (!code) return { kind: "missing" };
  const matches = items.filter((item) =>
    getCodes(item).some((candidate) => candidate != null && normalizeScanCode(candidate) === code),
  );
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
  return { kind: "match", item: matches[0] };
}

/** Exact non-negative decimal addition for scanner quantities; no IEEE-754 conversion. */
export function addScanQty(a: string, b: string): string {
  const parse = (value: string): [bigint, number] => {
    const trimmed = value.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("扫码数量必须是非负十进制数");
    const [integer, fraction = ""] = trimmed.split(".");
    return [BigInt(integer + fraction), fraction.length];
  };
  const [av, as] = parse(a);
  const [bv, bs] = parse(b);
  const scale = Math.max(as, bs);
  const sum = av * 10n ** BigInt(scale - as) + bv * 10n ** BigInt(scale - bs);
  if (scale === 0) return sum.toString();
  const raw = sum.toString().padStart(scale + 1, "0");
  return `${raw.slice(0, -scale)}.${raw.slice(-scale)}`.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
