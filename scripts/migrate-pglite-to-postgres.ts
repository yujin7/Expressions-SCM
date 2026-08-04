/**
 * 把开发用 PGlite 库里的真实业务数据整体搬到 PostgreSQL（实跑库）。
 *
 * 用法：
 *   PGLITE_DIR=/tmp/devsrc DATABASE_URL=postgres://... npx tsx scripts/migrate-pglite-to-postgres.ts
 *
 * 为什么需要它：容器化实跑用的是 PostgreSQL，是一个**全新的库**，
 * 只有 `db:seed` 的演示夹具（4 个 SKU）。而全部真实数据（5,376 SKU、818 BOM、
 * 9,182 条参考行等）一直在 `.data/dev` 这个 PGlite 文件库里——两者毫无关系。
 * 不搬过去，实跑系统看起来是空的。
 *
 * 关键做法与理由：
 *  - **保留原主键 ID**：外键、单据号、审计链都靠 ID 串起来，重新编号会把关系打散；
 *  - **session_replication_role = replica**：批量导入期间关掉用户触发器与外键校验。
 *    本库的 `stock_ledger` / `audit_logs` 有**仅追加触发器**，且表间外键很密，
 *    不关掉就要精确排出依赖顺序、还可能被触发器挡住；导入完成后立刻恢复；
 *  - **导入后重置序列**：显式插 ID 不会推进 sequence，不重置的话下一条新单据会
 *    撞主键冲突——这是这类迁移最常见的事后翻车点；
 *  - **先清空目标表**：目标只有演示夹具，且演示 ID 与真实 ID 会撞车。
 *
 * ⚠ 本脚本会清空目标库的业务表。只在「目标库是新建的实跑库」这个前提下用。
 */
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";

const PGLITE_DIR = process.env.PGLITE_DIR;
const TARGET = process.env.DATABASE_URL;

if (!PGLITE_DIR || !TARGET?.startsWith("postgres")) {
  console.error("需要 PGLITE_DIR 与 PostgreSQL 的 DATABASE_URL");
  process.exit(1);
}

/** 不搬的表：pg-boss 自己的队列、drizzle 迁移账本 */
const SKIP_SCHEMAS = new Set(["pgboss", "drizzle", "information_schema", "pg_catalog", "pg_toast"]);

async function main(): Promise<void> {
  const source = new PGlite(PGLITE_DIR!);
  const pool = new Pool({ connectionString: TARGET });
  const target = await pool.connect();

  const tablesRes = await source.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  /* 只搬「两边都有」的表。
     PGlite 用 `_migrations` 记迁移，PostgreSQL 用 `drizzle.__drizzle_migrations`，
     两边的迁移账本本就不同名——直接照源库清单去 TRUNCATE 会在这里炸。
     迁移账本也不该被搬：目标库自己的账本才反映它实际应用了哪些迁移。 */
  const targetTablesRes = await target.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'`,
  );
  const targetTables = new Set(targetTablesRes.rows.map((r) => r.tablename));

  const sourceTables = tablesRes.rows
    .map((r) => r.tablename)
    .filter((t) => !SKIP_SCHEMAS.has(t) && !t.startsWith("__"));
  const tables = sourceTables.filter((t) => targetTables.has(t) && t !== "_migrations");
  const onlyInSource = sourceTables.filter((t) => !tables.includes(t));

  console.log(`源库 ${sourceTables.length} 张表，其中 ${tables.length} 张目标库也有`);
  if (onlyInSource.length > 0) {
    console.log(`跳过（目标库没有或属迁移账本）：${onlyInSource.join(", ")}`);
  }
  console.log("");

  await target.query("BEGIN");
  // 关掉用户触发器与外键校验：本库有仅追加触发器，且外键密集
  await target.query("SET session_replication_role = 'replica'");

  let copied = 0;
  let skipped = 0;
  const report: { table: string; rows: number }[] = [];

  try {
    // 先全部清空，避免演示夹具与真实数据的 ID 撞车
    for (const table of [...tables].reverse()) {
      await target.query(`TRUNCATE TABLE "${table}" CASCADE`);
    }

    /* json/jsonb 列必须显式 JSON.stringify。
       node-postgres 遇到 JS 数组会按 **PostgreSQL 数组字面量**（`{a,b}`）序列化，
       而不是 JSON——插进 json 列就会报 `invalid input syntax for type json`。
       对象碰巧能work，数组不行，所以这个坑只在含数组的 json 列上炸。 */
    const jsonColsRes = await target.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema='public' and data_type in ('json','jsonb')`,
    );
    const jsonCols = new Map<string, Set<string>>();
    for (const c of jsonColsRes.rows) {
      if (!jsonCols.has(c.table_name)) jsonCols.set(c.table_name, new Set());
      jsonCols.get(c.table_name)!.add(c.column_name);
    }

    for (const table of tables) {
      const rowsRes = await source.query<Record<string, unknown>>(`select * from "${table}"`);
      const rows = rowsRes.rows;
      if (rows.length === 0) { skipped++; continue; }

      const tableJsonCols = jsonCols.get(table) ?? new Set<string>();
      const columns = Object.keys(rows[0]);
      const colList = columns.map((c) => `"${c}"`).join(",");

      // 分批插入，避免单条 SQL 参数过多
      const BATCH = 500;
      for (let offset = 0; offset < rows.length; offset += BATCH) {
        const slice = rows.slice(offset, offset + BATCH);
        const values: unknown[] = [];
        const tuples = slice.map((row, rowIndex) => {
          const placeholders = columns.map((col, colIndex) => {
            const raw = row[col];
            values.push(
              tableJsonCols.has(col) && raw !== null && raw !== undefined
                ? JSON.stringify(raw)
                : raw,
            );
            return `$${rowIndex * columns.length + colIndex + 1}`;
          });
          return `(${placeholders.join(",")})`;
        });
        await target.query(
          `INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(",")}`,
          values,
        );
      }
      copied++;
      report.push({ table, rows: rows.length });
    }

    /* 重置序列：显式插 ID 不会推进 sequence。
       不做这一步，下一条新单据会撞主键冲突——迁移后最常见的事后故障。 */
    const seqRes = await target.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema='public' and column_default like 'nextval%'`,
    );
    for (const { table_name, column_name } of seqRes.rows) {
      await target.query(
        `SELECT setval(pg_get_serial_sequence('"${table_name}"', '${column_name}'),
                       COALESCE((SELECT MAX("${column_name}") FROM "${table_name}"), 0) + 1, false)`,
      );
    }
    console.log(`已重置 ${seqRes.rows.length} 个序列\n`);

    await target.query("SET session_replication_role = 'origin'");
    await target.query("COMMIT");
  } catch (error) {
    await target.query("ROLLBACK");
    throw error;
  }

  report.sort((a, b) => b.rows - a.rows);
  console.log("搬运结果（前 15 张按行数）：");
  for (const r of report.slice(0, 15)) {
    console.log(`  ${r.table.padEnd(28)} ${String(r.rows).padStart(7)}`);
  }
  console.log(`\n共 ${copied} 张表有数据，${skipped} 张为空。`);

  target.release();
  await pool.end();
  await source.close();
}

void main().catch((error) => {
  console.error("迁移失败：", (error as Error).message);
  process.exit(1);
});
