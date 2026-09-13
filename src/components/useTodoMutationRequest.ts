"use client";
import { useEffect, useState } from "react";
import { loadTodoMutation, TODO_MUTATION_CHANGED, type TodoMutationRequest } from "./todo-mutation-request";

/** Mount below an actor-keyed boundary; storage is never read during SSR. */
export function useTodoMutationRequest(actorId: number) {
  const [state, setState] = useState<{ ready: boolean; request: TodoMutationRequest | null; error: string | null }>({ ready: false, request: null, error: null });
  useEffect(() => {
    const sync = () => {
      try { setState({ ready: true, request: loadTodoMutation(localStorage, actorId), error: null }); }
      catch (e) { setState({ ready: true, request: null, error: e instanceof Error ? e.message : "本机原操作无法读取，未发送新请求" }); }
    };
    sync(); window.addEventListener("storage", sync); window.addEventListener(TODO_MUTATION_CHANGED, sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener(TODO_MUTATION_CHANGED, sync); };
  }, [actorId]);
  return state;
}
