"use client";
import { useEffect, useState } from "react";
import { loadTodoCreate, TODO_CREATE_CHANGED, type TodoCreateRequest } from "./todo-create-request";
/** Caller is keyed by current actor. Store only pending intent, never credentials. */
export function useTodoCreateRequest(actorId: number) {
  const [state, setState] = useState<{ ready: boolean; request: TodoCreateRequest | null; error: string | null }>({ ready: false, request: null, error: null });
  useEffect(() => {
    const sync = () => { try { setState({ ready: true, request: loadTodoCreate(localStorage, actorId), error: null }); }
      catch (e) { setState({ ready: true, request: null, error: e instanceof Error ? e.message : "本机创建记录无法读取" }); } };
    sync(); window.addEventListener("storage", sync); window.addEventListener(TODO_CREATE_CHANGED, sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener(TODO_CREATE_CHANGED, sync); };
  }, [actorId]);
  return state;
}
