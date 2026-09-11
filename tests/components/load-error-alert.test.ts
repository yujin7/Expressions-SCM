import React, { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoadErrorAlert from "@/components/LoadErrorAlert";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("共享错误重试可访问名称", () => {
  it.each([false, true])("重试中=%s时名称不被AntD动画图标污染，忙碌状态单独表达", retrying => {
    const onRetry = vi.fn();
    const view = LoadErrorAlert({ error: "连接超时", subject: "告警关联", retrying, onRetry })!;
    const action = view.props.action as ReactElement<{ "aria-label": string; "aria-busy": boolean; loading: boolean; onClick: () => void }>;
    expect(action.props["aria-label"]).toBe("重试告警关联");
    expect(action.props["aria-busy"]).toBe(retrying);
    expect(action.props.loading).toBe(retrying);
    action.props.onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it("缺错误不展示重试，默认subject仍有稳定名称", () => {
    expect(LoadErrorAlert({ error: null, onRetry: vi.fn() })).toBeNull();
    const view = LoadErrorAlert({ error: "读取失败", onRetry: vi.fn() })!;
    const action = view.props.action as ReactElement<{ "aria-label": string }>;
    expect(action.props["aria-label"]).toBe("重试数据");
  });
});
