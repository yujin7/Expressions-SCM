"use client";
import { useEffect, useState } from "react";
import { loadTodoNote, TODO_NOTE_CHANGED, type TodoNoteRequest } from "./todo-note-request";

/** Mount below an actor-keyed boundary. Browser storage is never accessed during SSR. */
export function useTodoNoteRequest(actorId: number) {
  const [state, setState] = useState<{ ready: boolean; request: TodoNoteRequest | null; error: string | null }>({ ready: false, request: null, error: null });
  useEffect(() => {
    const sync = () => {
      try { setState({ ready: true, request: loadTodoNote(localStorage, actorId), error: null }); }
      catch (e) { setState({ ready: true, request: null, error: e instanceof Error ? e.message : "本机恢复记录无法读取，未发送请求" }); }
    };
    sync();
    window.addEventListener("storage", sync); window.addEventListener(TODO_NOTE_CHANGED, sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener(TODO_NOTE_CHANGED, sync); };
  }, [actorId]);
  return state;
}
