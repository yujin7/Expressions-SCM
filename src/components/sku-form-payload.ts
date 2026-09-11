const nullableFields = ["brandId", "channelId", "shortName", "spec", "version", "prodMode", "lossCategory",
  "shelfLifeDays", "nearExpiryDays", "normalLeadDays", "logisticsLeadDays"] as const;
const stateFields = ["lifecycle", "active", "commercialRole"] as const;
const normalized = (value: unknown) => value == null || (typeof value === "string" && value.trim() === "") ? null : value;

/** The complete edit form sends only changed optional fields; a deliberate clear is explicit null. */
export function skuFormPayload(values: Record<string, unknown>, editing: Record<string, unknown> | null): Record<string, unknown> {
  const payload = { ...values };
  for (const key of nullableFields) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const next = normalized(values[key]);
    if (editing) {
      if (next === normalized(editing[key])) delete payload[key];
      else payload[key] = next;
    } else if (next === null) delete payload[key];
  }
  if (editing) for (const key of stateFields) {
    if (values[key] === undefined || values[key] === editing[key]) delete payload[key];
  }
  return payload;
}
