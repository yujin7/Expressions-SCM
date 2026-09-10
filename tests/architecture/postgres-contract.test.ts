import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  assertPostgresAlertTriggers, assertPostgresMigrationHistory,
  assertRecentPostgresConstraints, assertRecentPostgresIndexes,
  expectedPostgresMigrations, normalizedPgDefinition, RECENT_PG_CONSTRAINTS, RECENT_PG_INDEXES,
  type AlertTriggerRow, type RecentConstraintRow, type RecentIndexRow,
} from "../../scripts/verify-postgres";

const expected = expectedPostgresMigrations(resolve(process.cwd(), "drizzle"));
const applied = expected.map((item) => ({ hash: item.hash, created_at: String(item.when) }));
const constraints = (): RecentConstraintRow[] => RECENT_PG_CONSTRAINTS.map(([table, name, definition]) => ({
  table_name: table, constraint_name: name.slice(0, 63), definition, validated: true,
}));
const indexes = (): RecentIndexRow[] => RECENT_PG_INDEXES.map((item) => ({
  table_name: item.table, index_name: item.name, valid: true, ready: true,
  unique: item.unique, columns: [...item.columns], predicate: item.predicate,
}));
const triggers = (): AlertTriggerRow[] => [
  { trigger_name: "alert_events_append_only", type: 27 },
  { trigger_name: "alert_events_append_only_truncate", type: 34 },
].map((item) => ({
  ...item, enabled: "O", function_schema: "public", function_name: "reject_immutable_fact_mutation",
  function_language: "plpgsql", function_returns: "trigger", condition: null, argument_count: 0,
  function_body: "\nBEGIN\n  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP\n    USING ERRCODE = '55000';\nEND;\n",
}));

describe("PostgreSQL 只读契约验证器（纯目录与合成 catalog，不连接数据库）", () => {
  it("采购收货行外键必须注册，不能只依赖迁移日志数量正确", () => {
    expect(RECENT_PG_CONSTRAINTS).toContainEqual([
      "sh_lines", "sh_lines_po_line_id_po_lines_id_fk", "FOREIGN KEY (po_line_id) REFERENCES po_lines(id)",
    ]);
  });
  it("每个 journal SQL 的 hash/时间与实际 Drizzle 迁移器一致，不靠固定数量或最后一条", () => {
    const drizzle = readMigrationFiles({ migrationsFolder: resolve(process.cwd(), "drizzle") });
    expect(expected.map(({ hash, when }) => ({ hash, folderMillis: when })))
      .toEqual(drizzle.map(({ hash, folderMillis }) => ({ hash, folderMillis })));
    expect(expected.some((row) => row.tag === "0060_integration_record_deletions")).toBe(true);
    expect(() => assertPostgresMigrationHistory(expected, [...applied].reverse())).not.toThrow();
  });

  it("遗漏任一旧迁移、只跑首条、或多出未知迁移都拒绝", () => {
    expect(() => assertPostgresMigrationHistory(expected, applied.slice(1))).toThrow(/count/);
    expect(() => assertPostgresMigrationHistory(expected, applied.slice(0, 1))).toThrow(/count/);
    expect(() => assertPostgresMigrationHistory(expected, [...applied, applied[0]])).toThrow(/count/);
  });

  it("数量正确也逐条核对 hash、时间、重复项", () => {
    const changedHash = applied.map((row, index) => index === 0 ? { ...row, hash: "0".repeat(64) } : row);
    expect(() => assertPostgresMigrationHistory(expected, changedHash)).toThrow(expected[0].tag);
    const changedTime = applied.map((row, index) => index === 0 ? { ...row, created_at: "1" } : row);
    expect(() => assertPostgresMigrationHistory(expected, changedTime)).toThrow(/timestamp\/hash/);
    const duplicate = [applied[1], ...applied.slice(1)];
    expect(() => assertPostgresMigrationHistory(expected, duplicate)).toThrow(/duplicate/);
    expect(() => assertPostgresMigrationHistory(expected, [{ ...applied[0], created_at: null }, ...applied.slice(1)])).toThrow(/Invalid/);
  });

  it("新外键/CHECK/UNIQUE 必须同时命中正确表、定义与 validated 状态", () => {
    expect(() => assertRecentPostgresConstraints(constraints())).not.toThrow();
    for (const expectedRow of constraints()) {
      const remaining = constraints().filter((row) => row.constraint_name !== expectedRow.constraint_name);
      expect(() => assertRecentPostgresConstraints(remaining)).toThrow(expectedRow.constraint_name);
      for (const mutation of [{ validated: false }, { table_name: "other_table" }, { definition: "CHECK (true)" }]) {
        const altered = constraints().map((row) => row.constraint_name === expectedRow.constraint_name ? { ...row, ...mutation } : row);
        expect(() => assertRecentPostgresConstraints(altered)).toThrow(expectedRow.constraint_name);
      }
    }
  });

  it("ack_reset 不能缺失，墓碑理由不能放宽，手写 QC 外键不能指错目标", () => {
    for (const [name, mutate] of [
      ["ck_alert_events_event", (sql: string) => sql.replace("'ack_reset'::text, ", "")],
      ["ck_integration_record_deletion_reason", (sql: string) => sql.replace(">= 4", ">= 0")],
      ["fk_qc_record_quality_case", (sql: string) => sql.replace("REFERENCES quality_cases", "REFERENCES qc_records")],
    ] as const) {
      const altered = constraints().map((row) => row.constraint_name === name ? { ...row, definition: mutate(row.definition) } : row);
      expect(() => assertRecentPostgresConstraints(altered)).toThrow(name);
    }
  });

  it("仅允许 PG16 实际目录格式的引号外空白变化，不接受附加 OR true", () => {
    const formatted = constraints().map((row) => row.constraint_name === "ck_alert_events_event"
      ? { ...row, definition: row.definition.replace("CHECK ", "CHECK\n\t").replace(" = ANY ", " \n=\tANY ") } : row);
    expect(() => assertRecentPostgresConstraints(formatted)).not.toThrow();
    const weakened = constraints().map((row) => row.constraint_name === "ck_alert_events_close_reason_required"
      ? { ...row, definition: `${row.definition} OR true` } : row);
    expect(() => assertRecentPostgresConstraints(weakened)).toThrow(/close_reason/);
  });

  it("保留字符串和带引号标识符内的空白、括号、转义引号以及函数结构", () => {
    expect(normalizedPgDefinition("  CHECK\n (\"a  (b)\" = 'x  (y)'' z')  "))
      .toBe("CHECK (\"a  (b)\" = 'x  (y)'' z')");
    expect(() => normalizedPgDefinition("CHECK (event = 'open)")).toThrow(/Unclosed quote/);
    for (const value of ["'open '", "' open'", "'(open)'", "'o(pen)'", "'o  pen'"]) {
      const altered = constraints().map((row) => row.constraint_name === "ck_alert_events_event"
        ? { ...row, definition: row.definition.replace("'open'", value) } : row);
      expect(() => assertRecentPostgresConstraints(altered)).toThrow(/ck_alert_events_event/);
    }
    for (const definition of [
      "CHECK ((lengthbtrimreason >= 4))",
      "CHECK ((length(btrimreason) >= 4))",
      "CHECK ((length(btrim(reason)) >= 4) OR true)",
    ]) {
      const altered = constraints().map((row) => row.constraint_name === "ck_integration_record_deletion_reason"
        ? { ...row, definition } : row);
      expect(() => assertRecentPostgresConstraints(altered)).toThrow(/ck_integration_record_deletion_reason/);
    }
  });

  it("部分索引的状态字面量和拒写函数中的字符串同样不能被归一化吞掉", () => {
    for (const value of ["'open '", "'(open)'"]) {
      const altered = indexes().map((row) => row.index_name === "uq_alert_open_dedupe"
        ? { ...row, predicate: row.predicate!.replace("'open'", value) } : row);
      expect(() => assertRecentPostgresIndexes(altered)).toThrow(/uq_alert_open_dedupe/);
    }
    const changedBody = triggers().map((row) => ({ ...row, function_body: row.function_body.replace("is append-only", "is  append-only") }));
    expect(() => assertPostgresAlertTriggers(changedBody)).toThrow(/immutable alert trigger/);
  });

  it("近期幂等索引必须 valid/ready，且唯一性、顺序列、部分谓词一致", () => {
    expect(() => assertRecentPostgresIndexes(indexes())).not.toThrow();
    for (const expectedRow of indexes()) {
      expect(() => assertRecentPostgresIndexes(indexes().filter((row) => row.index_name !== expectedRow.index_name))).toThrow(expectedRow.index_name);
      for (const mutation of [{ valid: false }, { ready: false }, { unique: !expectedRow.unique }, { columns: ["wrong"] }, { predicate: "false" }]) {
        const altered = indexes().map((row) => row.index_name === expectedRow.index_name ? { ...row, ...mutation } : row);
        expect(() => assertRecentPostgresIndexes(altered)).toThrow(expectedRow.index_name);
      }
    }
  });

  it("alert_events 的 update/delete 与 truncate 守卫均须启用并执行真正的拒写函数", () => {
    expect(() => assertPostgresAlertTriggers(triggers())).not.toThrow();
    expect(() => assertPostgresAlertTriggers(triggers().map((row) => ({ ...row, enabled: "A" })))).not.toThrow();
    for (const expectedRow of triggers()) {
      expect(() => assertPostgresAlertTriggers(triggers().filter((row) => row.trigger_name !== expectedRow.trigger_name))).toThrow(expectedRow.trigger_name);
      for (const mutation of [
        { enabled: "D" }, { enabled: "R" }, { type: 1 }, { condition: "false" }, { argument_count: 1 },
        { function_schema: "other" }, { function_name: "allow_mutation" }, { function_returns: "void" },
        { function_language: "sql" }, { function_body: "BEGIN RETURN NEW; END;" },
      ]) {
        const altered = triggers().map((row) => row.trigger_name === expectedRow.trigger_name ? { ...row, ...mutation } : row);
        expect(() => assertPostgresAlertTriggers(altered)).toThrow(expectedRow.trigger_name);
      }
    }
  });
});
