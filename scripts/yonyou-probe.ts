/**
 * Backwards-compatible operator entrypoint. The authoritative probe now lives in src/jobs so
 * CLI, scheduler, replay and job-ledger evidence all execute exactly the same implementation.
 */
import { loadJobEnvironment } from "../src/jobs/load-env";
import { runYonyouPermissionProbe } from "../src/jobs/probe-yonyou";

loadJobEnvironment();

runYonyouPermissionProbe()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (result.s !== "succeeded") process.exitCode = 2;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "用友探针失败");
    process.exitCode = 1;
  });
