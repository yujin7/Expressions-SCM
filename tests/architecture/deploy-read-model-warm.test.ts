/**
 * 架构护栏：部署后的读模型预热步骤必须真的可执行，且**失败不得让部署失败**。
 *
 * 背景（W2）：`report_read_model_cache` 的 key 带 `/vN`，口径一升版旧键就再没有读者。
 * `ops/deploy.sh` 此前止步于健康检查，于是**部署后第一个打开页面的人**触发同步重算——
 * 爆单模型实测要几分钟。缓存冷只是慢、不是坏，因此预热是「尽力而为」：
 * 失败只记录并继续，绝不把一次成功的部署判成失败。
 *
 * 这里钉住三件容易悄悄失效的事：
 *  1. 预热的任务名必须都在 `INTERVAL_JOBS` 白名单里——`run-job` 对未登记的名字直接报错，
 *     写错一个名字就变成一条永远失败的预热（而且没人会看部署日志的中间行）；
 *  2. 预热必须捕获退出码（`|| rc=$?`）。脚本开了 `set -e`，裸调一次失败就整段部署失败；
 *  3. 预热必须排在健康检查通过之后——健康没过就预热等于给一个起不来的环境做无用功。
 *
 * 另：为什么预热跑在 compose 的 migrate 服务里而不是宿主机——
 * `docker-compose.prod.yml` 的 db 服务没有 `ports:`，库只在 compose 网络内可达；
 * runner 镜像是 standalone 精简产物，既没有 tsx 也没有 src/。migrator 阶段（= build 阶段）
 * 是唯一同时具备 tsx、源码与 `DATABASE_URL=…@db:5432` 的地方。本测试也钉住这个选择，
 * 免得日后有人"顺手"把它改回宿主机跑，然后在生产上得到一条永远连不上库的预热。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { INTERVAL_JOBS } from "@/jobs/interval-runner";

const root = path.resolve(__dirname, "../..");
const deploy = readFileSync(path.join(root, "ops/deploy.sh"), "utf8");
const compose = readFileSync(path.join(root, "docker-compose.prod.yml"), "utf8");

/** `WARM_JOBS=${SCM_WARM_JOBS:-"a b c"}` 里的默认任务名 */
function defaultWarmJobs(): string[] {
  const m = /WARM_JOBS=\$\{SCM_WARM_JOBS:-"([^"]+)"\}/.exec(deploy);
  expect(m, "deploy.sh 缺少 WARM_JOBS 默认清单").not.toBeNull();
  return m![1].split(/\s+/).filter(Boolean);
}

describe("部署后读模型预热", () => {
  it("预热任务名全部登记在 INTERVAL_JOBS（否则 run-job 直接报未登记任务）", () => {
    const registered = new Set(INTERVAL_JOBS.map((j) => j.name));
    const jobs = defaultWarmJobs();
    expect(jobs.length, "预热清单为空 = 没有预热").toBeGreaterThan(0);
    const unknown = jobs.filter((j) => !registered.has(j));
    expect(unknown, `以下预热任务名未登记：${unknown.join(", ")}`).toEqual([]);
  });

  it("预热失败不让部署失败（捕获退出码，不裸调）", () => {
    // 脚本开了 set -euo pipefail：裸调一次失败就整段退出
    expect(deploy).toMatch(/set -euo pipefail/);
    const invocation = /compose --profile tools run --rm -T migrate npx tsx src\/jobs\/cli\.ts run-job "\$job"[^\n]*\|\| rc=\$\?/;
    expect(deploy, "预热调用必须以 `|| rc=$?` 捕获失败").toMatch(invocation);
    expect(deploy, "预热函数必须显式 return 0").toMatch(/预热汇总[\s\S]{0,120}return 0/);
  });

  it("预热排在健康检查之后，且健康检查失败仍然是部署失败", () => {
    const healthGate = deploy.indexOf('健康检查失败——检查 docker compose logs app');
    const warmCall = deploy.indexOf("warm_read_models\n");
    expect(healthGate).toBeGreaterThan(0);
    expect(warmCall).toBeGreaterThan(healthGate);
    expect(deploy).toMatch(/if \[ "\$healthy" -ne 1 \]; then\n\s+echo "健康检查失败[^\n]*\n\s+exit 1/);
  });

  it("滚动之前必须给在跑的镜像打 rollback- 标签（新镜像接管 latest 后旧镜像会被回收，回滚点就没了）", () => {
    const tagAt = deploy.indexOf("supply-chain-app:${rollback_label}");
    const buildAt = deploy.indexOf("compose build ");
    expect(tagAt, "deploy.sh 没有打回滚标签").toBeGreaterThan(-1);
    /* 必须在 build 之前而不是 up -d 之前：build 接管 latest 的瞬间旧镜像就成了悬空层，
       Docker Desktop 的构建 GC 会回收它。2026-09-06 实测：块放在 build 之后 → No such image，回滚点当场丢失。 */
    expect(tagAt, "回滚标签必须打在 `compose build` 之前，否则旧镜像已被回收").toBeLessThan(buildAt);
    expect(deploy, "已有应用的回滚标签失败必须阻断构建，首次空环境另作显式判定").toMatch(/if ! docker tag [^\n]*; then[\s\S]*?exit 1/);
    expect(deploy).toContain('"$rollback_image" != "$running_image"');
  });

  it("deploy.sh 必须同时 build app 与 migrate——预热跑在 migrate 里，工具镜像过期＝每次部署静默预热失败", () => {
    const buildLine = deploy.split("\n").find((l) => /^\s*compose build /.test(l));
    expect(buildLine, "找不到 compose build 行").toBeDefined();
    expect(buildLine, "只 build app 会让 migrate 工具镜像停在旧代码").toMatch(/\bmigrate\b/);
  });

  it("预热跑在 compose 网络内的 migrate 服务里（宿主机连不到 db，runner 里没有 tsx）", () => {
    // db 只在 compose 网络内可达：一旦有人给 db 加了 ports 映射，本断言会提醒重新评估宿主机方案
    const dbBlock = compose.slice(compose.indexOf("  db:"), compose.indexOf("  migrate:"));
    expect(dbBlock, "db 服务不应对宿主机暴露端口").not.toMatch(/^\s+ports:/m);
    // migrate 服务必须仍带 DATABASE_URL 且用 migrator（= build）阶段，否则预热镜像里没有 tsx/src
    expect(compose).toMatch(/target: migrator/);
    expect(compose).toMatch(/DATABASE_URL: postgres:\/\/scm:\$\{POSTGRES_PASSWORD\}@db:5432\/scm/);
  });
});
