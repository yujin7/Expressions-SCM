/**
 * SKU 前向编码标准 S1。
 *
 * 格式：S1-{来源}-{类型}-{六位全局流水}-{两位 CRC-8 校验码}
 * 示例：S1-EXP-F-000123-K7
 *
 * 这里只承载稳定身份：来源、货品类型、全局流水和录入防错码。渠道、规格、
 * 供应商、生命周期、BOM 父项等可变语义必须留在结构化字段/关系里。
 */

export const GOVERNED_SKU_SCHEME = "S1" as const;
export const GENERIC_SKU_ORIGIN = "GEN" as const;

export const SKU_TYPE_CODE = {
  finished: "F",
  semi: "H",
  raw: "R",
  packaging: "P",
  service: "V",
} as const;

export type GovernedSkuType = keyof typeof SKU_TYPE_CODE;
export type GovernedSkuTypeCode = (typeof SKU_TYPE_CODE)[GovernedSkuType];

const CODE_TO_SKU_TYPE = Object.fromEntries(
  Object.entries(SKU_TYPE_CODE).map(([type, code]) => [code, type]),
) as Record<GovernedSkuTypeCode, GovernedSkuType>;

const GOVERNED_PATTERN = /^S1-([A-Z0-9]{2,4})-([FHRPV])-(\d{6})-([0-9A-Z]{2})$/;
const MAX_SEQUENCE = 999_999;

export interface GovernedSkuParts {
  scheme: typeof GOVERNED_SKU_SCHEME;
  origin: string;
  skuType: GovernedSkuType;
  sequence: number;
  checksum: string;
}

/** 品牌短码只保留稳定的半角大写字母/数字；共享或中性物料使用 GEN。 */
export function normalizeSkuOrigin(raw: string | null | undefined): string {
  const origin = String(raw ?? "").trim().toUpperCase();
  if (!origin) return GENERIC_SKU_ORIGIN;
  if (!/^[A-Z0-9]{2,4}$/.test(origin)) {
    throw new Error("品牌短码须为 2–4 位大写字母或数字；共享/中性物料请使用 GEN");
  }
  return origin;
}

/**
 * CRC-8/ATM（poly=0x07）用于发现常见误录；不是签名或权限控制。
 * 输出以两位 base36 表示（CRC 最大 255，始终可放入两位）。
 */
export function skuCodeChecksum(payload: string): string {
  let crc = 0;
  for (const byte of new TextEncoder().encode(payload)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc.toString(36).toUpperCase().padStart(2, "0");
}

export function generateGovernedSkuCode(input: {
  origin?: string | null;
  skuType: GovernedSkuType;
  sequence: number;
}): string {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || input.sequence > MAX_SEQUENCE) {
    throw new Error(`SKU 全局流水须在 1–${MAX_SEQUENCE} 之间`);
  }
  const origin = normalizeSkuOrigin(input.origin);
  const typeCode = SKU_TYPE_CODE[input.skuType];
  const sequence = String(input.sequence).padStart(6, "0");
  const payload = `${GOVERNED_SKU_SCHEME}-${origin}-${typeCode}-${sequence}`;
  return `${payload}-${skuCodeChecksum(payload)}`;
}

export function parseGovernedSkuCode(raw: string): GovernedSkuParts | null {
  const code = raw.trim().toUpperCase();
  const match = GOVERNED_PATTERN.exec(code);
  if (!match) return null;
  const [, origin, typeCodeRaw, sequenceRaw, checksum] = match;
  const payload = `${GOVERNED_SKU_SCHEME}-${origin}-${typeCodeRaw}-${sequenceRaw}`;
  if (skuCodeChecksum(payload) !== checksum) return null;
  const sequence = Number(sequenceRaw);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) return null;
  const typeCode = typeCodeRaw as GovernedSkuTypeCode;
  return {
    scheme: GOVERNED_SKU_SCHEME,
    origin,
    skuType: CODE_TO_SKU_TYPE[typeCode],
    sequence,
    checksum,
  };
}

export function isGovernedSkuCode(raw: string): boolean {
  return /^S1-/i.test(raw.trim());
}

export function assertGovernedSkuCode(
  raw: string,
  expected?: { origin?: string | null; skuType?: GovernedSkuType },
): GovernedSkuParts {
  const parts = parseGovernedSkuCode(raw);
  if (!parts) {
    throw new Error("S1 编码格式或校验码错误；请留空让系统自动生成，或按编码说明检查");
  }
  if (expected?.origin !== undefined && parts.origin !== normalizeSkuOrigin(expected.origin)) {
    throw new Error(`S1 编码来源 ${parts.origin} 与所选品牌短码不一致`);
  }
  if (expected?.skuType !== undefined && parts.skuType !== expected.skuType) {
    throw new Error("S1 编码类型与所选 SKU 类型不一致");
  }
  return parts;
}
