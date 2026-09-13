import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClosingActions } from "@/components/DocTransitionActions";
import { closingStorageKey, readClosingMarker, startClosingMarker } from "@/components/doc-transition-recovery";
const h=vi.hoisted(()=>({cursor:0,slots:[] as unknown[],effects:[] as (()=>void)[],cleanups:new Map<number,()=>void>(),changed:false,
  fetch:vi.fn(),changedDoc:vi.fn(),success:vi.fn(),listeners:new Map<string,(event:unknown)=>void>()}));
vi.mock("antd",()=>({Alert:"alert",Button:"button",Modal:"modal",Space:"space",Input:{TextArea:"textarea"},
  Typography:{Text:"text",Paragraph:"paragraph"},App:{useApp:()=>({message:{success:h.success}})}}));
vi.mock("@/components/DocStatusTag",()=>({default:"status"}));
vi.mock("@/components/useMe",()=>({useMe:()=>null,hasAnyRole:()=>false}));
vi.mock("@/components/fetchJson",()=>({fetchJson:h.fetch}));
vi.mock("react",async original=>({...await original<typeof import("react")>(),
  useRef:(initial:unknown)=>{const i=h.cursor++;if(!(i in h.slots))h.slots[i]={current:initial};return h.slots[i];},
  useState:<T,>(initial:T)=>{const i=h.cursor++;if(!(i in h.slots))h.slots[i]=initial;return [h.slots[i],(update:T|((old:T)=>T))=>{const next=typeof update==="function"?(update as (old:T)=>T)(h.slots[i] as T):update;if(!Object.is(next,h.slots[i]))h.changed=true;h.slots[i]=next;}];},
  useEffect:(fn:()=>void|(()=>void),deps:readonly unknown[])=>{const i=h.cursor++,old=h.slots[i] as readonly unknown[]|undefined;if(old?.length===deps.length&&old.every((v,j)=>Object.is(v,deps[j])))return;h.slots[i]=deps;h.effects.push(()=>{h.cleanups.get(i)?.();const cleanup=fn();if(cleanup)h.cleanups.set(i,cleanup);});},
}));
type Node=React.ReactElement<Record<string,unknown>&{children?:ReactNode}>;
const nodes=(v:ReactNode):Node[]=>Array.isArray(v)?v.flatMap(nodes):isValidElement<Node["props"]>(v)?[v,...nodes(v.props.children),...nodes(v.props.description as ReactNode)]:[];
let props:Parameters<typeof ClosingActions>[0],data:Map<string,string>;
const key=closingStorageKey(1,"po",3),token="7d0821a7-b0d0-4b39-8cb5-9ab456fc47c2";
const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};
function render():ReactNode{for(let i=0;i<10;i++){h.cursor=0;h.changed=false;const tree=ClosingActions(props);for(const effect of h.effects.splice(0))effect();if(!h.changed)return tree;}throw Error("render loop");}
const button=(text:string)=>nodes(render()).find(n=>n.type==="button"&&n.props.children===text)!;
const click=(text:string)=>(button(text).props.onClick as ()=>void)();
const modal=()=>nodes(render()).find(n=>n.type==="modal")!;
const confirm=()=>(modal().props.onOk as ()=>void)();
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();render();};
const snapshot=(status="closed")=>({id:3,docNo:"PO-3",status,version:6,closedReason:status==="closed"?"不再补齐":null});
const unmount=()=>{for(const f of h.cleanups.values())f();h.cleanups.clear();};
const reason=(text:string)=>(nodes(render()).find(n=>n.type==="textarea")!.props.onChange as (e:unknown)=>void)({target:{value:text}});
beforeEach(()=>{h.slots=[];h.effects=[];h.cleanups.clear();h.listeners.clear();h.fetch.mockReset();h.success.mockClear();h.changedDoc.mockClear();data=new Map();
  props={actorId:1,canAct:true,docType:"po",doc:{id:3,docNo:"PO-3",version:5,status:"in_progress"},onChanged:h.changedDoc,labels:{completeHint:"仅收口本单",shortCloseHint:"不会关闭关联单据"}};
  vi.stubGlobal("React",React);vi.stubGlobal("localStorage",storage);vi.stubGlobal("crypto",{randomUUID:()=>token});
  vi.stubGlobal("window",{addEventListener:(name:string,fn:(e:unknown)=>void)=>h.listeners.set(name,fn),removeEventListener:(name:string)=>h.listeners.delete(name)});
});
afterEach(()=>{unmount();vi.unstubAllGlobals();});
it("short-close reason required; waiting locks same-tick submits and modal closure",async()=>{
  click("短关");expect(modal().props.okButtonProps).toMatchObject({disabled:true});expect(modal().props.styles).toEqual({body:{maxHeight:"calc(100dvh - 200px)",overflowY:"auto"}});confirm();expect(h.fetch).not.toHaveBeenCalled();reason("不再补齐");
  const response=Promise.withResolvers<unknown>();h.fetch.mockReturnValue(response.promise);confirm();confirm();
  expect(h.fetch).toHaveBeenCalledTimes(1);expect(readClosingMarker(storage,key)).not.toBeNull();expect(modal().props.closable).toBe(false);
  (modal().props.onCancel as ()=>void)();expect(modal().props.open).toBe(true);
  h.fetch.mockResolvedValueOnce(snapshot());response.resolve({status:"closed",idempotent:false});await flush();
  expect(h.fetch).toHaveBeenCalledTimes(2);expect(h.fetch.mock.calls[1][1].method).toBeUndefined();expect(readClosingMarker(storage,key)).toBeNull();expect(h.changedDoc).toHaveBeenCalledTimes(1);
});
it("lost POST response survives remount and terminal state; recovery only GETs then explicitly acknowledges",async()=>{
  click("完成");h.fetch.mockRejectedValueOnce(Error("lost"));confirm();await flush();expect(h.changedDoc).not.toHaveBeenCalled();
  unmount();h.slots=[];h.effects=[];props.doc.status="completed";props.canAct=false;
  expect(button("核对当前状态")).toBeDefined();expect(button("完成")).toBeUndefined();h.fetch.mockResolvedValue(snapshot("completed"));
  click("核对当前状态");await flush();expect(h.fetch).toHaveBeenCalledTimes(2);expect(h.fetch.mock.calls[1][1].method).toBeUndefined();
  click("已核对，刷新单据");expect(readClosingMarker(storage,key)).toBeNull();expect(h.changedDoc).toHaveBeenCalledTimes(1);
});
it("failed GET after successful POST retains marker and reason, without another write",async()=>{
  click("短关");reason("不再补齐");h.fetch.mockResolvedValueOnce({status:"closed",idempotent:false}).mockRejectedValueOnce(Error("read failed"));
  confirm();await flush();confirm();expect(h.fetch).toHaveBeenCalledTimes(2);expect(readClosingMarker(storage,key)).not.toBeNull();expect(h.success).not.toHaveBeenCalled();
  expect(nodes(render()).find(n=>n.type==="textarea")!.props.value).toBe("不再补齐");
});
it("document changed after confirmation opened cannot borrow its new version",()=>{
  click("完成");props.doc={...props.doc,version:6};render();confirm();expect(h.fetch).not.toHaveBeenCalled();
});
it("permission lost before/during POST prevents new write or late success callbacks",async()=>{
  click("完成");const staleConfirm=modal().props.onOk as ()=>void;props.canAct=false;render();staleConfirm();expect(h.fetch).not.toHaveBeenCalled();props.canAct=true;render();
  const response=Promise.withResolvers<unknown>();h.fetch.mockReturnValue(response.promise);confirm();props.canAct=false;render();response.resolve({status:"completed",idempotent:false});await flush();
  expect(h.fetch).toHaveBeenCalledTimes(1);expect(h.changedDoc).not.toHaveBeenCalled();expect(readClosingMarker(storage,key)).not.toBeNull();
});
it("unmount during request cannot update another document",async()=>{
  click("完成");const response=Promise.withResolvers<unknown>();h.fetch.mockReturnValue(response.promise);confirm();unmount();response.resolve({status:"completed",idempotent:false});
  for(let i=0;i<20;i++)await Promise.resolve();expect(h.changedDoc).not.toHaveBeenCalled();expect(h.success).not.toHaveBeenCalled();expect(readClosingMarker(storage,key)).not.toBeNull();
});
it("another tab marker blocks writing; unrelated storage does not erase typed reason",async()=>{
  click("短关");reason("保留此原因");h.listeners.get("storage")!({storageArea:storage,key:"other"});expect(nodes(render()).find(n=>n.type==="textarea")!.props.value).toBe("保留此原因");
  startClosingMarker(storage,key,"complete",5);h.listeners.get("storage")!({storageArea:storage,key});render();confirm();await flush();expect(h.fetch).not.toHaveBeenCalled();
});
it("late acknowledgement never removes a different tab's newer marker",async()=>{
  startClosingMarker(storage,key,"complete",5);render();h.fetch.mockResolvedValue(snapshot());click("核对当前状态");await flush();
  data.set(key,JSON.stringify({token:"ed404ea2-2810-46ae-957b-1599e98148c9",action:"short_close",version:7}));click("已核对，刷新单据");
  expect(readClosingMarker(storage,key)?.version).toBe(7);expect(h.changedDoc).not.toHaveBeenCalled();
});
it("a current state different from POST's target remains an explicit reconciliation, not success",async()=>{
  click("完成");h.fetch.mockResolvedValueOnce({status:"completed",idempotent:false}).mockResolvedValueOnce(snapshot("in_progress"));confirm();await flush();
  expect(h.success).not.toHaveBeenCalled();expect(readClosingMarker(storage,key)).not.toBeNull();expect(h.changedDoc).not.toHaveBeenCalled();
});
it("invalid persisted marker never silently enables another write, even after a successful GET",async()=>{
  data.set(key,"{");render();expect(button("完成")).toBeUndefined();expect(button("核对当前状态")).toBeDefined();expect(h.fetch).not.toHaveBeenCalled();
  h.fetch.mockResolvedValue(snapshot("in_progress"));click("核对当前状态");await flush();
  expect(button("完成")).toBeUndefined();expect(button("核对当前状态")).toBeDefined();expect(data.get(key)).toBe("{");
});
