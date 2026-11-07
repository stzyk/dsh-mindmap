/**
 * dsh-mindmap — 右侧栏里的导图 tab 定义（Client 半区）。
 *
 * 为什么改成"在会话右侧打开导图"（而不是占满主区域）：
 *   DSH 的右侧栏**依附于已挂载的会话界面**。导图占满主区域时主区域被换掉，
 *   会话界面卸载，右侧栏就没有挂载点（实测报 "no session surface is mounted"）。
 *   把导图本身放进右侧栏，对话留在主区域，两边同时可见——这正是用户要的
 *   "在对话框里和导图交互"。
 *
 * 注册分两步（和图像工作台同一套机制）：
 *   ① 这里声明 tab 类型；
 *   ② index.tsx 里把组件挂到 `sidebar.right.pane.tab`，key 相同。
 */

import * as React from "react";

/**
 * 首页卡片上的图标。
 *
 * 内置的几个 guide 条目都带图标（文件 / 终端 / Git），没有图标时虽然
 * 契约上允许（会画一个方块占位），但视觉上和它们不齐，所以自己画一个。
 */
function MindmapGuideIcon({ size = 20 }: { size?: number }): React.ReactElement {
  return React.createElement(
    "svg",
    { width: size, height: size, viewBox: "0 0 20 20", fill: "none", "aria-hidden": true },
    React.createElement("rect", {
      x: 1.5, y: 7.5, width: 5, height: 5, rx: 1.5,
      stroke: "currentColor", strokeWidth: 1.4,
    }),
    React.createElement("rect", {
      x: 13.5, y: 1.5, width: 5, height: 5, rx: 1.5,
      stroke: "currentColor", strokeWidth: 1.4,
    }),
    React.createElement("rect", {
      x: 13.5, y: 13.5, width: 5, height: 5, rx: 1.5,
      stroke: "currentColor", strokeWidth: 1.4,
    }),
    React.createElement("path", {
      d: "M6.5 10h3.5V4h3.5M10 10v6h3.5",
      stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round",
    }),
  );
}

/** tab 类型标识。第二步注册面板时要用同一个 key。 */
export const MINDMAP_TAB_ID = "mindmap";

/**
 * tab 类型定义（第一步）。
 *
 * 不带 `patterns` / `canOpen`：那是给"按资源地址打开的文档型 tab"用的。
 * 导图是**按会话打开的页面型 tab**，走 `openTab("mindmap")` 直接开。
 */
export function mindmapTabDefinition(): {
  id: string;
  kind: string;
  priority: "extension";
  title: () => string;
  guide: Array<{
    id: string;
    order: number;
    title: () => string;
    description: () => string;
    icon: (props: { size?: number }) => React.ReactElement;
  }>;
} {
  return {
    id: MINDMAP_TAB_ID,
    kind: MINDMAP_TAB_ID,
    // 外部插件带来的类型，按 DSH 规则排在所有内置查看器之前
    priority: "extension",
    title: () => "思维导图",
    /*
     * 首页卡片（就是「图像工作台」那种入口）。
     *
     * 入口必须在**右侧抽屉首页**里，不能放左侧边栏：
     * 左侧那是"切换到某个主面板"的语义，会占满主区域、把会话界面换掉，
     * 而导图需要和对话并存。
     */
    guide: [
      {
        id: "open-mindmap",
        order: 60,
        title: () => "思维导图",
        description: () => "和对话一起用的导图，可直接改结构、生成与总结",
        icon: MindmapGuideIcon,
      },
    ],
  };
}
