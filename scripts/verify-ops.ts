import { readFileSync, readdirSync, statSync } from "node:fs";
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
// standalone 产物不含 public/，漏拷则生产环境所有静态资源 404（dev 却正常）。
requireText("Dockerfile", "COPY --from=build /app/public ./public");
// Next.js standalone 不设 HOSTNAME 会只绑容器 IP，容器内 127.0.0.1 无监听 →
// healthcheck 永远失败、容器长期 unhealthy（宿主机端口映射却是通的，极易漏判）。
requireText("docker-compose.prod.yml", 'HOSTNAME: "0.0.0.0"');

/*
 * 连接器环境变量必须逐个透传进生产 compose，否则容器里那条集成静默失效。
 *
 * ⚠ 本检查原来是**一份手写清单**——于是本轮新增 FEISHU_WEBHOOK_SECRET、
 * JST_TRUSTED_WMS_CO_IDS 等变量时，compose 漏了、检查却照样绿。
 * 尤其 FEISHU_WEBHOOK_SECRET 缺失会让唯一跑通的那条集成（签名 webhook）
 * 在容器里发不出消息，而本地却是好的——最难查的那类差异。
 *
 * 改为**从源码推导**：扫描集成层与任务层里读取的 `env.XXX` / `process.env.XXX`，
 * 凡是连接器前缀的键都必须在 compose 里出现。新增变量时不会再漏。
 */
const CONNECTOR_PREFIXES = ["FEISHU_", "JST_", "JIANDAOYUN_", "YY_"];
const SOURCE_DIRS = ["src/server/integrations", "src/jobs"];

function collectConnectorEnvKeys(): string[] {
  const keys = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    for (const entry of readdirSync(path.join(root, dir))) {
      if (!entry.endsWith(".ts")) continue;
      const src = read(path.join(dir, entry));
      // ① 直接读取：env.JST_XXX / process.env["JST_XXX"]
      for (const match of src.matchAll(/(?:process\.)?env(?:\.|\[")([A-Z][A-Z0-9_]+)/g)) {
        const key = match[1];
        if (CONNECTOR_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.add(key);
      }
      // ② 间接读取：const TRUSTED_WMS_ENV = "JST_TRUSTED_WMS_CO_IDS" 之后 env[TRUSTED_WMS_ENV]。
      //    只扫①会漏掉这种写法——本轮 JST_TRUSTED_WMS_CO_IDS 正是这样被漏掉的。
      for (const match of src.matchAll(/=\s*"([A-Z][A-Z0-9_]+)"/g)) {
        const key = match[1];
        if (CONNECTOR_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

const connectorEnvKeys = collectConnectorEnvKeys();
if (connectorEnvKeys.length < 20) {
  failures.push(`connector env scan only found ${connectorEnvKeys.length} keys — scanner likely broken`);
}
for (const key of connectorEnvKeys) {
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
