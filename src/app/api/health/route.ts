import { NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { readMigrationReadiness } from "@/server/core/migration-readiness";

/** Public readiness: database connectivity and known migration counts must both pass. */
export async function GET() {
  const { dbOk, migrations, hint } = await readMigrationReadiness(getDbAsync);
  return NextResponse.json(
    {
      ok: dbOk && migrations.ready,
      dbOk,
      migrationFiles: migrations.files,
      applied: migrations.applied,
      drift: migrations.drift,
      migrationState: migrations.state,
      ...(hint ? { hint } : {}),
      ...(!dbOk ? { error: hint } : {}),
    },
    { status: dbOk && migrations.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
