import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");
const failures: string[] = [];

function requireText(relative: string, pattern: string): void {
  if (!read(relative).includes(pattern)) failures.push(`${relative}: missing ${JSON.stringify(pattern)}`);
}

for (const script of [
  "ops/backup.sh",
  "ops/check-backup.sh",
  "ops/restore-drill.sh",
  "ops/deploy.sh",
]) {
  if ((statSync(path.join(root, script)).mode & 0o111) === 0) {
    failures.push(`${script}: must be executable`);
  }
}

requireText("ops/backup.sh", "REQUIRE_BACKUP_REMOTE");
requireText("ops/backup.sh", "backup_$STAMP.sha256");
requireText("ops/backup.sh", "--env-file");
requireText("ops/backup.sh", "--profile ops run --pull never");
requireText("ops/check-backup.sh", "sha256sum -c");
requireText("ops/check-backup.sh", "uploads_$stamp.tar.gz");
requireText("ops/restore-drill.sh", "scm-restore-drill-");
requireText("ops/restore-drill.sh", "drizzle.__drizzle_migrations");
requireText("ops/deploy.sh", "scm-backup-check.timer");
requireText("ops/deploy.sh", "--env-file");
requireText("ops/deploy.sh", '. "$BACKUP_ENV_FILE"');
requireText(".env.example", "POSTGRES_PASSWORD=");
requireText(".env.backup.example", "BACKUP_REMOTE=");
requireText(".gitignore", ".env.prod");
requireText(".gitignore", ".env.backup");
requireText("docker-compose.prod.yml", "healthcheck:");
requireText("docker-compose.prod.yml", "max-size: \"10m\"");
requireText("docker-compose.prod.yml", "uploads:/data/uploads:ro");

for (const key of [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_CHAT_ID",
  "FEISHU_WEBHOOK_URL",
  "FEISHU_APP_LIVE_VERIFIED_AT",
  "FEISHU_APP_LIVE_VERIFIED_REF",
  "FEISHU_WEBHOOK_LIVE_VERIFIED_AT",
  "FEISHU_WEBHOOK_LIVE_VERIFIED_REF",
  "JST_APP_KEY",
  "JST_APP_SECRET",
  "JST_ACCESS_TOKEN",
  "JST_SYNC_ACTOR_ID",
  "JST_BASE_URL",
  "JST_INVENTORY_SYNC_ENABLED",
  "JST_LIVE_VERIFIED_AT",
  "JST_LIVE_VERIFIED_REF",
  "JIANDAOYUN_API_KEY",
  "JIANDAOYUN_SYNC_ACTOR_ID",
  "JIANDAOYUN_SYNC_ENABLED",
  "JIANDAOYUN_SYNC_CONTRACTS",
  "JIANDAOYUN_BASE_URL",
  "JIANDAOYUN_LIVE_VERIFIED_AT",
  "JIANDAOYUN_LIVE_VERIFIED_REF",
  "YY_APP_KEY",
  "YY_APP_SECRET",
  "YY_CLIENT_ID",
  "YY_CLIENT_SECRET",
  "YY_TENANT_ID",
  "YY_ORG_ID",
  "YY_PRODUCT_PROFILE",
  "YY_APPROVED_API_CONTRACTS",
  "YY_ALLOWED_HOSTS",
  "YY_BASE_URL",
  "YY_TOKEN_URL",
]) {
  requireText("docker-compose.prod.yml", `${key}: \${${key}-}`);
}

requireText(
  ".github/workflows/ci.yml",
  "gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e",
);
requireText(".github/workflows/ci.yml", "fetch-depth: 0");
requireText(".gitleaksignore", "tests/replenish/sop-cycle.test.ts:generic-api-key");

if (read("ops/backup.sh").includes("supply-chain_uploads")) {
  failures.push("ops/backup.sh: hard-coded Docker volume name is forbidden");
}

const uat = read("docs/spec/07-UAT场景矩阵与并行运行手册.md");
const scenarioIds = new Set(
  [...uat.matchAll(/^\| (O\d+|P\d+|C\d+|W\d+|F\d+|N\d+) \|/gm)].map((match) => match[1]),
);
if (scenarioIds.size !== 41) failures.push(`UAT matrix: expected 41 unique scenarios, got ${scenarioIds.size}`);
if (!uat.includes("41 个场景")) failures.push("UAT matrix: exit criterion must say 41 scenarios");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  "operations contracts: OK (atomic backup set, connector env pass-through, secret scan, monitoring, 41-scenario UAT)",
);
