/** Node/server-only readiness probe. Counts are a release prerequisite, not a full schema audit. */
import { readdirSync } from "node:fs";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";

export interface MigrationReadiness {
  files: number;
  applied: number;
  /** True only for a confirmed count mismatch; unknown is separately not ready. */
  drift: boolean;
  state: "current" | "behind" | "ahead" | "unknown";
  ready: boolean;
}

interface ReadDb {
  execute(query: SQL): PromiseLike<unknown>;
}

interface DatabaseReadiness {
  dbOk: boolean;
  migrations: MigrationReadiness;
  hint?: string;
}

function missingRelation(error: unknown): boolean {
  // Drizzle wraps the database error in `cause`. Never infer absence from message text.
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if ("code" in error) return error.code === "42P01";
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}

function ledgerCount(result: unknown): number | undefined {
  if (!result || typeof result !== "object" || !("rows" in result) || !Array.isArray(result.rows) || result.rows.length !== 1) return undefined;
  const row: unknown = result.rows[0];
  if (!row || typeof row !== "object" || !("c" in row)) return undefined;
  const value = row.c;
  if (typeof value !== "number" && (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && count <= 2_147_483_647 ? count : undefined;
}

export async function readMigrationReadiness(resolveDb: () => PromiseLike<ReadDb>): Promise<DatabaseReadiness> {
  let files = -1;
  try {
    files = readdirSync(path.resolve(process.cwd(), "drizzle")).filter((name) => name.endsWith(".sql")).length;
  } catch { /* An unreadable candidate directory is unknown, never an empty/current schema. */ }

  const migrations: MigrationReadiness = { files, applied: -1, drift: false, state: "unknown", ready: false };
  let db: ReadDb;
  try {
    db = await resolveDb();
    await db.execute(sql`SELECT 1`);
  } catch {
    return { dbOk: false, migrations, hint: "数据库不可用，尚不能确认迁移就绪。请联系运维核对目标环境。" };
  }

  // Only a confirmed missing table permits trying the other ledger. If both exist,
  // do not guess which one belongs to this deployment or choose a matching count.
  const counts: number[] = [];
  let ledgerKnown = true;
  for (const statement of [
    sql`SELECT count(*)::int AS c FROM _migrations`,
    sql`SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations`,
  ]) {
    try {
      const count = ledgerCount(await db.execute(statement));
      if (count === undefined) { ledgerKnown = false; break; }
      counts.push(count);
    } catch (error) {
      if (!missingRelation(error)) { ledgerKnown = false; break; }
    }
  }
  if (ledgerKnown && counts.length === 1) migrations.applied = counts[0];

  if (files <= 0) {
    return { dbOk: true, migrations, hint: "迁移文件清单不可读或为空，尚不能确认就绪。请核对候选构建产物。" };
  }
  if (migrations.applied < 0) {
    return { dbOk: true, migrations, hint: "迁移账本不可确认，尚不能放行。请人工核对账本存在性、读取权限及目标数据库；勿直接删除账本。" };
  }

  migrations.state = migrations.applied < files ? "behind" : migrations.applied > files ? "ahead" : "current";
  migrations.drift = migrations.state !== "current";
  migrations.ready = migrations.state === "current";
  const hint = migrations.state === "behind"
    ? "迁移落后：已应用数少于候选文件数。请核对目标并按发布流程补齐迁移。"
    : migrations.state === "ahead"
      ? "迁移超前：已应用数多于候选文件数。请核对应用候选与数据库版本，不可直接放行旧候选。"
      : undefined;
  return { dbOk: true, migrations, ...(hint ? { hint } : {}) };
}
