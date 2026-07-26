"use client";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { unstableSetRender } from "antd";

type RootContainer = Element & { _antdReactRoot?: Root };

/**
 * Ant Design 5 / React 19 compatibility.
 *
 * React 19 removed ReactDOM.render, so AntD 5 static APIs (Modal/message/notification)
 * need an explicit createRoot renderer. This is Ant Design's documented fallback when
 * @ant-design/v5-patch-for-react-19 is not available.
 */
unstableSetRender((node: ReactNode, container) => {
  const rootContainer = container as RootContainer;
  rootContainer._antdReactRoot ??= createRoot(container);
  rootContainer._antdReactRoot.render(node);

  return async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rootContainer._antdReactRoot?.unmount();
    delete rootContainer._antdReactRoot;
  };
});

export default function AntdReact19Compat() {
  return null;
}
