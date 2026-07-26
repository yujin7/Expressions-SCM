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
console.log("operations contracts: OK (atomic backup set, restore drill, monitoring, 41-scenario UAT)");
