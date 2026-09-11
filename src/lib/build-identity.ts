/** Public, non-secret build identity. This is traceability, not artifact attestation. */
export type BuildIdentity = {
  revision: string | null;
  source: "git-clean" | "git-dirty" | "build-arg" | "unknown";
};

export const isSourceRevision = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

export function parseBuildIdentity(value: unknown): BuildIdentity {
  if (value && typeof value === "object") {
    const b = value as Record<string, unknown>;
    if (isSourceRevision(b.revision) && (b.source === "git-clean" || b.source === "git-dirty" || b.source === "build-arg")) {
      return { revision: b.revision, source: b.source as BuildIdentity["source"] };
    }
  }
  return { revision: null, source: "unknown" };
}

export function matchesBuildRevision(value: unknown, expected: unknown): boolean {
  const b = parseBuildIdentity(value);
  return isSourceRevision(expected) && b.revision === expected
    && (b.source === "git-clean" || b.source === "build-arg");
}
