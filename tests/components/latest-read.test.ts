import { expect, it } from "vitest";
import { createLatestReadScope } from "@/components/useLatestRead";

it("aborts the previous read and rejects its late response even when transport ignores abort", async () => {
  const scope = createLatestReadScope();
  const old = scope.begin(), pending = Promise.withResolvers<string>();
  let result = "", loading = true;
  const finish = pending.promise.then(value => { if (old.isCurrent()) result = value; })
    .finally(() => { if (old.isCurrent()) loading = false; });
  const fresh = scope.begin();
  expect(old.signal.aborted).toBe(true);
  pending.resolve("obsolete"); await finish;
  expect(result).toBe(""); expect(loading).toBe(true);
  expect(fresh.isCurrent()).toBe(true);
});

it("an old error cannot replace a fresh success or end a newer spinner", async () => {
  const scope = createLatestReadScope(), old = scope.begin();
  const pending = Promise.withResolvers<void>(); let error = "", loading = true;
  const finish = pending.promise.catch(() => { if (old.isCurrent()) error = "old failure"; })
    .finally(() => { if (old.isCurrent()) loading = false; });
  scope.begin(); pending.reject(Error("late")); await finish;
  expect(error).toBe(""); expect(loading).toBe(true);
});

it("unmount cancels reads; a strict-mode remount can start a new lane", () => {
  const scope = createLatestReadScope(), read = scope.begin();
  scope.cancel(); scope.cancel();
  expect(read.signal.aborted).toBe(true); expect(read.isCurrent()).toBe(false);
  expect(scope.begin().isCurrent()).toBe(true);
});

it("independent tables never cancel one another", () => {
  const a = createLatestReadScope(), b = createLatestReadScope();
  const firstA = a.begin(), firstB = b.begin(); a.begin();
  expect(firstA.isCurrent()).toBe(false); expect(firstB.isCurrent()).toBe(true);
});
