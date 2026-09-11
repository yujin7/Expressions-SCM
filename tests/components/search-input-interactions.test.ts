import React, { type ReactElement } from "react";
import type { SearchProps } from "antd/es/input/Search";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SearchInput from "@/components/SearchInput";

// Callback contract only; the production browser suite exercises real AntD inputs.
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }));
vi.mock("antd", () => ({ Input: "input", Button: "button" }));
vi.mock("@ant-design/icons", () => ({ SearchOutlined: "icon" }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  forwardRef: (render: (props: SearchProps, ref: null) => ReactElement) => (props: SearchProps) => render(props, null),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[i], (value: unknown) => { hooks.slots[i] = value; }];
  },
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = { current: initial };
    return hooks.slots[i];
  },
  useEffect: (effect: () => void) => effect(),
}));

type InputProps = React.ComponentProps<typeof import("antd").Input>;
type ButtonProps = React.ComponentProps<typeof import("antd").Button>;
function render(props: SearchProps) {
  hooks.cursor = 0;
  const tree = SearchInput(props) as ReactElement<{ children: [ReactElement<InputProps>, ReactElement<ButtonProps>] }>;
  return { input: tree.props.children[0].props, button: tree.props.children[1].props };
}
const keyEvent = (value: string, extra: Partial<React.KeyboardEvent<HTMLInputElement>> = {}) => ({
  currentTarget: { value }, defaultPrevented: false, nativeEvent: { isComposing: false }, ...extra,
}) as React.KeyboardEvent<HTMLInputElement>;
beforeEach(() => { hooks.cursor = 0; hooks.slots = []; vi.stubGlobal("React", React); });
afterEach(() => vi.unstubAllGlobals());

it("submits the event value on Enter rather than a stale controlled value", () => {
  const onSearch = vi.fn();
  render({ value: "old", onSearch }).input.onPressEnter!(keyEvent("新值"));
  expect(onSearch).toHaveBeenCalledWith("新值", expect.anything(), { source: "input" });
});

it("does not submit while composing Chinese and forwards composition callbacks", () => {
  const onSearch = vi.fn(), onCompositionStart = vi.fn(), onCompositionEnd = vi.fn();
  const { input } = render({ onSearch, onCompositionStart, onCompositionEnd });
  const composition = {} as React.CompositionEvent<HTMLInputElement>;
  input.onCompositionStart!(composition);
  input.onPressEnter!(keyEvent("新品"));
  expect(onSearch).not.toHaveBeenCalled();
  input.onCompositionEnd!(composition);
  input.onPressEnter!(keyEvent("新品"));
  expect(onSearch).toHaveBeenCalledTimes(1);
  expect(onCompositionStart).toHaveBeenCalledWith(composition);
  expect(onCompositionEnd).toHaveBeenCalledWith(composition);
});

it("recognizes native IME and legacy 229 Enter events", () => {
  const onSearch = vi.fn();
  const { input } = render({ onSearch });
  input.onPressEnter!(keyEvent("新品", { nativeEvent: { isComposing: true } as KeyboardEvent }));
  input.onPressEnter!(keyEvent("新品", { keyCode: 229 }));
  expect(onSearch).not.toHaveBeenCalled();
});

it.each([{ disabled: true }, { loading: true }])("ignores submit while unavailable: %j", unavailable => {
  const onSearch = vi.fn();
  const { input, button } = render({ ...unavailable, value: "新品", onSearch });
  input.onPressEnter!(keyEvent("新品"));
  button.onClick!({} as React.MouseEvent<HTMLElement>);
  expect(onSearch).not.toHaveBeenCalled();
});

it("honors an Enter handler that prevents submission", () => {
  const onSearch = vi.fn();
  render({ onSearch, onPressEnter: event => { Object.defineProperty(event, "defaultPrevented", { value: true }); } })
    .input.onPressEnter!(keyEvent("新品"));
  expect(onSearch).not.toHaveBeenCalled();
});

it("clear submits an empty filter once with its source and still reports the change", () => {
  const onSearch = vi.fn(), onChange = vi.fn();
  const event = { type: "click", target: { value: "" } } as React.ChangeEvent<HTMLInputElement>;
  render({ value: "新品", onSearch, onChange }).input.onChange!(event);
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("", event, { source: "clear" });
  expect(onChange).toHaveBeenCalledExactlyOnceWith(event);
});

it("typing does not submit and an uncontrolled button uses the current draft", () => {
  const onSearch = vi.fn();
  const props = { defaultValue: "old", onSearch };
  render(props).input.onChange!({ type: "change", target: { value: "新品" } } as React.ChangeEvent<HTMLInputElement>);
  expect(onSearch).not.toHaveBeenCalled();
  render(props).button.onClick!({} as React.MouseEvent<HTMLElement>);
  expect(onSearch).toHaveBeenCalledWith("新品", expect.anything(), { source: "input" });
});
