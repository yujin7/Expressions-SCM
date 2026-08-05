"use client";

/*
 * 必须是客户端组件。
 *
 * antd 5 每个组件模块自带 "use client"，因此在**服务端组件**里 import 拿到的是
 * 客户端引用代理而非真实模块——代理上没有 `Skeleton.Input` 这类复合子组件，
 * 取到 undefined，渲染 <undefined /> 就抛「Element type is invalid…got: undefined」
 * （生产构建里显示为 Minified React error #130）。
 *
 * 这个文件是 (app) 段的 Suspense 兜底，只在**客户端跳转**时渲染，直接打开 URL
 * 走 SSR 反而看不到——所以它坏掉后的表现是「从侧边栏点进某些页面就报错，
 * 刷新一下又好了」，很容易被误判成偶发。
 * 护栏：tests/architecture/rsc-antd-compound.test.ts
 */
import { Card, Skeleton, Space } from "antd";

export default function Loading() {
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Skeleton.Input active size="small" />
      <Card>
        <Skeleton active paragraph={{ rows: 8 }} />
      </Card>
    </Space>
  );
}
