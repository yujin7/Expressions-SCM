import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { isSourceRevision, type BuildIdentity } from "../src/lib/build-identity";

/** Called by next.config at compilation, never by a request or the deployed runtime. */
export function readBuildIdentity(cwd: string, declared = ""): BuildIdentity {
  if (declared && !isSourceRevision(declared)) throw new Error("构建版本必须是完整40位小写Git提交；不接受分支名或短版本。");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const root = git("rev-parse", "--show-toplevel");
  if (root !== null) {
    // Never borrow a parent repository's revision for an untracked source export.
    if (realpathSync(root) !== realpathSync(cwd)) throw new Error("构建目录不是源码仓库根目录；拒绝借用父目录提交。");
    const revision = git("rev-parse", "HEAD");
    const status = git("status", "--porcelain=v1", "-uall");
    if (!isSourceRevision(revision) || status === null) throw new Error("无法核实构建源码版本或工作区状态。");
    if (declared && declared !== revision) throw new Error("声明的构建版本与当前源码提交不一致。");
    return { revision, source: status ? "git-dirty" : "git-clean" };
  }
  if (existsSync(path.join(cwd, ".git"))) throw new Error("存在Git元数据但不可读取；拒绝用声明版本替代核验。");
  // Docker intentionally excludes Git history. The controlled deploy path supplies
  // this argument after checking a clean checkout before and after the build.
  // Plain source exports without that pipeline remain explicitly unknown.
  return declared ? { revision: declared, source: "build-arg" } : { revision: null, source: "unknown" };
}
