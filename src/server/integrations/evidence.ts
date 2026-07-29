import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { storageDir, storageRoot } from "@/server/core/storage";

const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface IntegrationEvidence {
  relativePath: string;
  hash: string;
  bytes: string;
}

function assertSegment(value: string, label: string): void {
  if (!SEGMENT.test(value)) throw new Error(`${label} 非法`);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
          left.localeCompare(right, "en")),
      );
    }
    return item;
  }, 2)}\n`;
}

/**
 * Persist the connector's canonical, field-minimized source envelope under the protected storage
 * volume. Content-addressing makes replays idempotent; mode 0600 keeps vendor evidence private.
 */
export async function writeIntegrationEvidence(
  connector: string,
  stream: string,
  envelope: unknown,
): Promise<IntegrationEvidence> {
  assertSegment(connector, "connector");
  assertSegment(stream, "stream");
  const bytes = stableJson(envelope);
  const hash = createHash("sha256").update(bytes, "utf8").digest("hex");
  const dir = storageDir("integration-evidence", connector, stream);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const finalPath = path.join(dir, `${hash}.json`);
  const temporaryPath = path.join(dir, `.${hash}.${process.pid}.tmp`);
  try {
    await writeFile(temporaryPath, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    const existing = await readFile(finalPath, "utf8").catch(() => null);
    if (existing !== bytes) throw error;
  }
  return {
    relativePath: path.relative(storageRoot(), finalPath).split(path.sep).join("/"),
    hash,
    bytes,
  };
}
