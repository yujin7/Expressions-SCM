import React, { isValidElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import ScannerEntry from "@/components/ScannerEntry";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: () => ({ current: null }), useState: (value: unknown) => [value, vi.fn()], useEffect: vi.fn(),
}));
vi.mock("antd", () => ({ Input: "input", InputNumber: "number", Space: "space", Typography: { Text: "text" } }));
vi.mock("@ant-design/icons", () => ({ BarcodeOutlined: "barcode" }));
type Node = { type: unknown; props: { children?: ReactNode; style?: Record<string, unknown>; [key: string]: unknown } };
afterEach(() => vi.unstubAllGlobals());
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

it("scanner input can shrink within narrow parent and quantity label stays with its control", () => {
  vi.stubGlobal("React", React);
  const tree = nodes(ScannerEntry({ help: "扫描后累加到当前行", onScan: vi.fn() }));
  const input = tree.find(n => n.props["aria-label"] === "扫码输入")!;
  expect(input.props.style).toMatchObject({ minWidth: 0, flex: "1 1 260px", width: "100%" });
  const row = tree.find(n => n.props.style?.display === "flex" && n.props.style?.flexWrap === "wrap")!;
  expect(row).toBeDefined();
  expect(nodes(row.props.children).some(n => n.type === "space")).toBe(false);
  const quantityGroup = tree.find(n => n.props.style?.display === "flex" && n.props.style?.flexShrink === 0)!;
  expect(nodes(quantityGroup.props.children).some(n => n.props["aria-label"] === "每次扫码数量")).toBe(true);
  expect(nodes(quantityGroup.props.children).some(n => n.props.children === "每次计入")).toBe(true);
});
