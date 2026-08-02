export type ReleaseActionKey =
  | "sku_cost"
  | "snapshot"
  | "sales"
  | "batch"
  | "spu"
  | "sku"
  | "bom"
  | "bom_activate"
  | "fee";

export interface ReleaseActionScope {
  action: ReleaseActionKey;
  jobId: number;
  preflightToken: string | null;
}

export interface BoundReleaseActionResult {
  scope: ReleaseActionScope;
  data: Record<string, unknown>;
}

export function releaseActionScope(
  action: ReleaseActionKey,
  jobId: number | null,
  preflightToken: string | null,
): ReleaseActionScope | null {
  return jobId === null ? null : { action, jobId, preflightToken };
}

export function sameReleaseActionScope(
  left: ReleaseActionScope | null,
  right: ReleaseActionScope | null,
): boolean {
  return left !== null
    && right !== null
    && left.action === right.action
    && left.jobId === right.jobId
    && left.preflightToken === right.preflightToken;
}

export function isCurrentReleasePreview(
  preview: BoundReleaseActionResult | null,
  scope: ReleaseActionScope | null,
): boolean {
  return preview !== null
    && sameReleaseActionScope(preview.scope, scope)
    && preview.data.dryRun === true;
}

export function currentReleaseActionResult(
  result: BoundReleaseActionResult | null,
  scope: ReleaseActionScope | null,
): Record<string, unknown> | null {
  return result !== null && sameReleaseActionScope(result.scope, scope)
    ? result.data
    : null;
}
