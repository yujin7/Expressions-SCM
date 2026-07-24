"use client";

/**
 * E6-P4 可逆性标准：**写后撤销**优于写前确认。
 *
 * 背景（UX 审计）：全系统没有一处撤销——状态下拉一选即写库（误触=已写入）、
 * 批量登记点确认即成。现代标准是先执行 + 一条带「撤销」的 toast，
 * 而不是每次都用确认弹窗打断用户。
 *
 * 用法：
 *   const run = useUndoable();
 *   run({
 *     label: "已登记 12 项处置",
 *     do: () => postJson("/api/...", body),
 *     undo: () => postJson("/api/...", { intent: "revert", ... }),
 *     onSettled: reload,
 *   });
 *
 * 纪律：
 * - `undo` 必须是**真实的反向写操作**（如红字冲销、状态回退），不得只是前端假装；
 *   没有真实反向操作的动作（如过账、审批通过）**不要用本 hook**——那类动作应保留确认弹窗。
 * - 撤销窗口 6 秒，超时即消失（不阻塞后续操作）。
 */
import { App } from "antd";
import { useCallback } from "react";

export interface UndoableAction<T = unknown> {
  /** 成功后 toast 上显示的文案（陈述已发生的事，如「已登记 12 项」） */
  label: string;
  /** 正向操作 */
  do: () => Promise<T>;
  /** 反向操作——必须是真实写回滚；无真实回滚则不要用本 hook */
  undo: () => Promise<unknown>;
  /** 正向或撤销完成后的收尾（通常是列表刷新） */
  onSettled?: () => void;
  /** 撤销窗口秒数，默认 6 */
  seconds?: number;
}

export function useUndoable() {
  const { message } = App.useApp();

  return useCallback(
    async <T,>(action: UndoableAction<T>): Promise<T | undefined> => {
      try {
        const result = await action.do();
        const key = `undo-${Date.now()}`;
        message.open({
          key,
          type: "success",
          duration: action.seconds ?? 6,
          content: (
            <span>
              {action.label}
              <a
                style={{ marginLeft: 12 }}
                onClick={() => {
                  message.destroy(key);
                  void action
                    .undo()
                    .then(() => message.info("已撤销"))
                    .catch((e) => message.error(`撤销失败：${(e as Error).message}`))
                    .finally(() => action.onSettled?.());
                }}
              >
                撤销
              </a>
            </span>
          ),
        });
        action.onSettled?.();
        return result;
      } catch (e) {
        message.error((e as Error).message);
        return undefined;
      }
    },
    [message],
  );
}
