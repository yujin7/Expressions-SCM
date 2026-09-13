/** Cycle identity is navigation context, never approval or a grant of access. */
function validId(id: number): boolean { return Number.isInteger(id) && id > 0 && id <= 2_147_483_647; }

export function sopCycleHref(id: number): string | null {
  return validId(id) ? `/replenish/sop?cycleId=${id}` : null;
}

export function sopCycleTarget(query: string) {
  const values = new URLSearchParams(query).getAll("cycleId");
  if (!values.length) return { id: null, error: null };
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0]) || !validId(Number(values[0]))) {
    return { id: null, error: "周期链接无效；请返回最近周期重新选择，或向发送人索取准确链接。" };
  }
  return { id: Number(values[0]), error: null };
}

export function sopCycleTargetPath(query: string, id: number | null, hash = ""): string {
  if (id !== null && !validId(id)) throw new Error("无效的周期 ID");
  const params = new URLSearchParams(query);
  if (id === null) params.delete("cycleId"); else params.set("cycleId", String(id));
  return `/replenish/sop${params.size ? `?${params}` : ""}${hash}`;
}
