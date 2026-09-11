/**
 * C1 回归：过账错误码 → HTTP 的路由表必须由**类型派生**，不能在 route 层手抄。
 *
 * 事故形状：`post.ts` 抛 `CLOSED_PERIOD` 时写了完整的处置指引
 * （「纠错请按当前开放期间做红字冲销，或由管理员先重开该期间」），
 * 而 `master/common.errorResponse` 的放行名单是三条手抄字面量
 * `["NEGATIVE_STOCK","SNAPSHOT_WAREHOUSE","LOCATED_STOCK"]`——期间锁的码不在里面。
 * 于是每一次期间锁拒绝都变成带 errorId 的 500、落进 `error_logs` 当「未预期错误」，
 * 用户只看到「系统错误，请联系管理员」，指引被整段丢掉。
 *
 * 本文件钉两件事：
 *  1. `POSTING_ERROR_CODES` 里的**每一个**码都在路由表里有归属（新增码不登记即红）；
 *  2. 用户可见的那几个码经 `errorResponse` 真的拿到 409 + 原文，而不是 500 + errorId。
 */
import { describe, expect, it } from "vitest";
import {
  POSTING_ERROR_CODES,
  POSTING_ERROR_HTTP_STATUS,
  isUserFacingPostingError,
  type PostingErrorCode,
} from "@/server/posting/error-codes";
import { PostingError } from "@/server/posting/post";
import { errorResponse } from "@/server/modules/master/common";

describe("C1 过账错误码路由表", () => {
  it("每一个错误码都必须登记 HTTP 归属——新增码没登记就红（期望列表由类型派生，不再抄字面量）", () => {
    expect(POSTING_ERROR_CODES.length).toBeGreaterThan(0);
    for (const code of POSTING_ERROR_CODES) {
      expect(
        Object.hasOwn(POSTING_ERROR_HTTP_STATUS, code),
        `新增的过账错误码 ${code} 没有在 posting/error-codes.ts 登记 HTTP 归属——`
          + "不登记就会掉进未预期 500，用户看不到你写的那句指引",
      ).toBe(true);
      expect([409, 500]).toContain(POSTING_ERROR_HTTP_STATUS[code]);
    }
    // 反向：路由表里不得有错误码全集之外的幽灵条目（改名后残留会让守卫失效）
    expect(Object.keys(POSTING_ERROR_HTTP_STATUS).sort())
      .toEqual([...POSTING_ERROR_CODES].sort());
  });

  it("业务冲突类（含 CLOSED_PERIOD）经 errorResponse 得到 409 + 原文，不进 error_logs", async () => {
    const businessCodes = POSTING_ERROR_CODES.filter((c) => POSTING_ERROR_HTTP_STATUS[c] === 409);
    expect(businessCodes, "期间锁必须是用户可见的业务冲突").toContain<PostingErrorCode>("CLOSED_PERIOD");
    for (const code of businessCodes) {
      const message = `${code} 的原文必须回显给用户`;
      const res = errorResponse(new PostingError(code, message));
      expect(res.status, `${code} 应为 409`).toBe(409);
      const body = await res.json() as { error: string; errorId?: string };
      expect(body.error).toBe(message);
      expect(body.errorId, `${code} 不该被当成未预期错误落 error_logs`).toBeUndefined();
    }
  });

  it("期间锁的完整指引（红字冲销 / 重开期间）确实到得了用户手上", async () => {
    const guidance = "会计期间 2026-07 已关账，拒绝过账 count_adjust#1"
      + "（纠错请按当前开放期间做红字冲销，或由管理员先重开该期间）";
    const res = errorResponse(new PostingError("CLOSED_PERIOD", guidance));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("红字冲销");
    expect(body.error).toContain("重开该期间");
  });

  it("装配类错误（空事件 / 未注册来源）仍走未预期 500——那是调用方写错了，不是用户能处置的事", async () => {
    for (const code of POSTING_ERROR_CODES.filter((c) => POSTING_ERROR_HTTP_STATUS[c] === 500)) {
      expect(isUserFacingPostingError(code)).toBe(false);
      const res = errorResponse(new PostingError(code, "内部装配错误"));
      expect(res.status).toBe(500);
    }
  });
});
