/**
 * dsh-mindmap — 思维导图（Client 半区入口）。
 *
 * 挂在两个插槽上，这是一个完整"全局面板"的最小组合：
 *
 *   1. `main`（keyed，scope=root）
 *      主区域面板本体。key 就是面板 id，侧边栏的图标会把它选中进来。
 *      注册在这里而不是 shell.overlay：导图是要专心看的东西，
 *      不该压在会话上面的浮层里。
 *
 *   2. `sidebar.panellist`（list，scope=root）
 *      侧边栏的图标行条目，id 必须与 main 的 key 相同——侧边栏按 id
 *      把图标和面板配对（见 ui-sidebar 的 SidebarPanelMetadata 注释：
 *      "List id and matching main panel key"）。
 *
 * 两个插槽都通过 `slots.inject(name, cb)` 注册：插槽被声明之后 cb 才跑，
 * 未来插槽不存在时也不会抛错。返回值是 disposer，插件卸载时自动清理。
 *
 * 状态放在 apply() 创建的 store 里，生命周期 = 插件生命周期。
 * 面板切走再切回来不会丢草稿（存的是 store，不是组件 state）。
 */

import * as React from "react";

import { CSS, STYLE_ID } from "./styles.ts";
import { CanvasToolbar, KeyboardHints, MindMapCanvas } from "./Canvas.tsx";
import { DocList } from "./DocList.tsx";
import { MarkdownPanel } from "./MarkdownPanel.tsx";
import { StylePanel } from "./StylePanel.tsx";
import { locate, pathTo } from "../core/tree.ts";
import { createStore, PLUGIN_ID, type MindmapStore, type ViewState } from "./store.ts";
import type { MindNode } from "../core/tree.ts";

/** 面板 id：main 的 key 与 sidebar.panellist 的 id 必须一致。 */
export const PANEL_ID = "mindmap";

/** 严格注入：插槽服务 + 布局服务（图标点进面板由侧边栏驱动，这里不需要 layout）。 */
export const inject = ["slots"];

/** 宿主传进来的插槽服务面（结构化最小类型，避免版本耦合）。 */
interface SlotsService {
  inject(name: string, callback: () => unknown): unknown;
  register(meta: Record<string, unknown>, component: unknown): unknown;
}

interface ClientContext {
  effect(fn: () => unknown, label?: string): unknown;
  slots?: SlotsService;
}

/**
 * 面板外壳：订阅 store，按 mode 渲染三个视图之一。
 *
 * 用 useSyncExternalStore 而不是 Context：store 是插件级的单例，
 * Context 需要一层 Provider 包在每个插槽注册里，而两个插槽是两个
 * 独立的注册点，包起来反而绕。getSnapshot 返回同一个对象引用，
 * 只有 store 真的 set 过才会触发重渲染。
 */
function MindMapApp({ store }: { store: MindmapStore }): React.ReactElement {
  const state: ViewState = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  /**
   * 属性抽屉要显示的那个节点（主选中项）以及它在**布局里的层级**。
   *
   * 层级必须和布局算的一致（根 = 0），否则面板显示的"当前字号/是否加粗"
   * 会和画布上实际画出来的对不上：根节点默认 13.5px 加粗，其它节点 13px 常规。
   *
   * 多主题时 doc.root 是个不渲染的容器，布局是拿它的 children 各自当根排的，
   * 所以层级要再减 1。
   */
  const styleTarget = React.useMemo(() => {
    if (state.doc === null || state.selectedId === null) return undefined;
    const trail = pathTo(state.doc.root, state.selectedId);
    const found = locate(state.doc.root, state.selectedId);
    if (found === undefined) return undefined;
    const base = state.doc.multiTheme === true ? 1 : 0;
    return { node: found.node, depth: Math.max(0, trail.length - 1 - base) };
  }, [state.doc, state.selectedId]);

  // 首次挂载拉一次列表：面板可能已经开着页面却刚热更了插件
  React.useEffect(() => {
    if (state.loading) void store.boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mm-root" data-mm-root="true">
      {state.mode === "list" ? (
        <DocList store={store} state={state} />
      ) : (
        <>
          <CanvasToolbar store={store} state={state} />
          {/*
           * 画布 + 右侧 Markdown 栏并排。
           *
           * Markdown 不再是"和画布二选一的视图"：画布永远在，右栏可以随时
           * 收起（mdOpen）。这样用户能一边看画布一边改 Markdown，
           * 而不是在两种模式间来回切。
           */}
          <div className="mm-split" data-md-open={state.mdOpen ? "true" : "false"}>
            <div className="mm-split-main">
              <MindMapCanvas store={store} state={state} />
            </div>
            {/*
             * 右侧抽屉区：属性抽屉 + Markdown 栏并排，各自独立开关。
             *
             * 属性从"画布下方横条"改成右侧抽屉：横条会挤占画布高度，
             * 导图一深就得上下滚；抽屉只占宽度，画布高度不变。
             * 两个都在右侧，所以用同一列顺序摆放，窄屏时自动上下堆叠。
             */}
            {styleTarget !== undefined && state.styleOpen ? (
              <div className="mm-split-side mm-split-style" data-mm-side="style">
                <StylePanel
                  store={store}
                  state={state}
                  node={styleTarget.node}
                  depth={styleTarget.depth}
                  selectedIds={state.selectedIds}
                />
              </div>
            ) : null}
            {state.mdOpen ? (
              <div className="mm-split-side" data-mm-side="markdown">
                <MarkdownPanel store={store} state={state} />
              </div>
            ) : null}
          </div>
          <KeyboardHints />
        </>
      )}

      {state.toast !== null ? (
        <div className="mm-toast" data-tone={state.toast.tone} role="status" aria-live="polite">
          {state.toast.text}
        </div>
      ) : null}
    </div>
  );
}

/** 侧边栏图标：一条从中心分叉的枝。 */
function MindmapIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.3,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
    },
    // 中心节点
    React.createElement("rect", { x: 1, y: 6.5, width: 4, height: 3, rx: 1 }),
    // 两条分支
    React.createElement("path", { d: "M5 8h2.5" }),
    React.createElement("path", { d: "M7.5 8c1.2 0 1.2-3 2.5-3h1" }),
    React.createElement("path", { d: "M7.5 8c1.2 0 1.2 3 2.5 3h1" }),
    // 两个末端节点
    React.createElement("rect", { x: 11, y: 3.5, width: 4, height: 3, rx: 1 }),
    React.createElement("rect", { x: 11, y: 9.5, width: 4, height: 3, rx: 1 }),
  );
}

/** 注册 Client 半区。 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.slots;
  if (slots === undefined) {
    console.warn("[" + PLUGIN_ID + "] slots 服务不可用，界面未注册");
    return;
  }

  const store = createStore();

  // 样式：挂在 document.head，卸载时整张移除
  ctx.effect(() => {
    const existing = document.getElementById(STYLE_ID);
    existing?.remove();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, "mindmap styles");

  // 主面板
  slots.inject("main", () => {
    let dispose: unknown;
    try {
      dispose = slots.register(
        { name: "main", key: PANEL_ID, label: "思维导图" },
        () => React.createElement(MindMapApp, { store }),
      );
    } catch (error) {
      console.error("[" + PLUGIN_ID + "] main 插槽注册失败：", error);
    }
    return () => {
      if (typeof dispose === "function") (dispose as () => void)();
    };
  });

  // 侧边栏图标
  slots.inject("sidebar.panellist", () => {
    let dispose: unknown;
    try {
      dispose = slots.register(
        { name: "sidebar.panellist", id: PANEL_ID, order: 40, label: "思维导图" },
        MindmapIcon,
      );
    } catch (error) {
      console.error("[" + PLUGIN_ID + "] sidebar.panellist 插槽注册失败：", error);
    }
    return () => {
      if (typeof dispose === "function") (dispose as () => void)();
    };
  });

  // 启动即拉一次列表：这样侧边栏点进来是热的，不用等首屏
  void store.boot();

  ctx.effect(() => {
    return () => {
      store.dispose();
    };
  }, "mindmap store");

  // 调试句柄：自动化冒烟用它读状态、触发动作（不影响正常使用）
  const handle = {
    version: "0.8.0",
    state: (): ViewState => store.getSnapshot(),
    create: (title?: string): Promise<void> => store.create(title),
    open: (id: string): Promise<void> => store.open(id),
    back: (): void => store.back(),
    refresh: (): Promise<void> => store.refresh(),
    showMarkdown: (): void => store.showMarkdown(),
    closeMarkdown: (): void => store.closeMarkdown(),
    select: (id: string | null): void => store.select(id),
    selectEdge: (id: string | null): void => store.selectEdge(id),
    selectFreeLink: (id: string | null): void => store.selectFreeLink(id),
    center: (): void => {
      document.querySelector<HTMLElement>('[data-mm-action="center"]')?.click();
    },
    addFreeLink: (from: string, to: string): boolean => store.addFreeLink(from, to),
    removeFreeLink: (id: string): void => store.removeFreeLink(id),
    repointEdge: (a: string, b: string, pos?: { x: number; y: number }): boolean =>
      store.repointEdge(a, b, pos),
    selectMany: (ids: string[]): void => store.selectMany(ids),
    hideStyle: (): void => store.hideStyle(),
    undo: (): void => store.undo(),
    redo: (): void => store.redo(),
    duplicate: (ids?: string[]): string[] => store.duplicate(ids),
    reparent: (id: string, newParentId: string): boolean => store.reparent(id, newParentId),
    setEdgeLabel: (id: string, text: string): void => store.setEdgeLabel(id, text),
    toggleMark: (id: string, key: string): boolean => store.toggleMark(id, key),
    // 工具条按钮已移除（v0.15.1），这些动作仍可由键盘/双击触发；
    // 调试句柄保留一份，测试和排查时不用去模拟按键。
    addTheme: (position?: { x: number; y: number }): string | undefined => store.addTheme(position),
    styleNode: (id: string, changes: Record<string, unknown>, subtree = false): void =>
      store.styleNode(id, changes as never, subtree),
    edit: (id: string | null): void => store.edit(id),
    mutate: (root: MindNode): void => store.mutate(root),
    flush: (): Promise<void> => store.flush(),
    toast: (text: string): void => store.toast(text),
  };
  (window as unknown as { __mindmap?: typeof handle }).__mindmap = handle;

  ctx.effect(() => {
    return () => {
      if ((window as unknown as { __mindmap?: unknown }).__mindmap === handle) {
        delete (window as unknown as { __mindmap?: unknown }).__mindmap;
      }
    };
  }, "mindmap debug handle");
}
