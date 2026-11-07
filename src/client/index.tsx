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
import { EdgePanel } from "./EdgePanel.tsx";
import { AiPanel, type AiMessage } from "./AiPanel.tsx";
import { MINDMAP_TAB_ID, mindmapTabDefinition } from "./aiTab.ts";
import { locate, pathTo } from "../core/tree.ts";
import { createStore, PLUGIN_ID, type MindmapStore, type ViewState } from "./store.ts";
import type { MindNode } from "../core/tree.ts";

/** 面板 id：main 的 key 与 sidebar.panellist 的 id 必须一致。 */
export const PANEL_ID = "mindmap";

/** 严格注入：插槽服务 + 布局服务（图标点进面板由侧边栏驱动，这里不需要 layout）。 */
/*
 * slots：面板插槽。
 * sidebarRightTabs / sidebarRight：右侧栏的 tab 类型注册与打开入口
 * （AI 助手抽屉用；两者都声明成必需——缺一个就注册不了，
 *  不如让它在加载时就报错，而不是等到用户点开才发现是空白）。
 */
export const inject = ["slots", "sidebarRightTabs", "sidebarRight"];

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
  /**
   * 当前选中的连线（父子连线优先，其次自由连线）。
   * 有它就把抽屉切换成连线属性面板。
   */
  const edgeTarget: {
    kind: "tree" | "free";
    id: string;
    style?: "solid" | "dashed";
    width?: number;
    color?: string;
  } | undefined = (() => {
    if (state.doc === null) return undefined;
    if (state.selectedEdgeId !== null) {
      const found = locate(state.doc.root, state.selectedEdgeId);
      if (found === undefined) return undefined;
      const node = found.node;
      return {
        kind: "tree" as const,
        id: node.id,
        ...(node.edgeStyle !== undefined ? { style: node.edgeStyle } : {}),
        ...(node.edgeWidth !== undefined ? { width: node.edgeWidth } : {}),
        ...(node.edgeColor !== undefined ? { color: node.edgeColor } : {}),
      };
    }
    if (state.selectedFreeLinkId !== null) {
      const link = (state.doc.links ?? []).find((item) => item.id === state.selectedFreeLinkId);
      if (link === undefined) return undefined;
      return {
        kind: "free",
        id: link.id,
        ...(link.style !== undefined ? { style: link.style } : {}),
        ...(link.width !== undefined ? { width: link.width } : {}),
        ...(link.color !== undefined ? { color: link.color } : {}),
      };
    }
    return undefined;
  })();

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
            {/*
             * 画布区：画布本体 + 属性抽屉。
             *
             * 抽屉挂在这里（而不是 .mm-split 上）是**定位基准**的考虑：
             * 抽屉是 absolute 浮层，挂在画布区里它就只会盖住画布；
             * 挂在 .mm-split 上会连右边的 Markdown 栏一起盖住——
             * 同时开着 Markdown 时，抽屉会把 Markdown 整个挡掉，
             * 连它的「收起」按钮都点不到。
             */}
            <div className="mm-split-main">
              <MindMapCanvas store={store} state={state} />

              {/*
               * 属性抽屉：**只由工具栏「属性」按钮开关**（面板自己的 × 也能关）。
               *
               * 属性从"画布下方横条"改成右侧抽屉：横条会挤占画布高度，
               * 导图一深就得上下滚；抽屉只占宽度，画布高度不变。
               *
               * 内容是"当前选中的对象"，所以只有一个抽屉：
               *   选中连线 → 连线属性；选中节点 → 节点属性；都没选 → 一句提示。
               * 两个抽屉本来就互斥（选节点会清掉连线选中，反之亦然），
               * 所以没必要做两个按钮，也不会出现两个面板抢位置。
               */}
              {state.styleOpen ? (
                edgeTarget !== undefined ? (
                  <div className="mm-split-side mm-split-style" data-mm-side="edge-style">
                    <EdgePanel
                      store={store}
                      state={state}
                      kind={edgeTarget.kind}
                      targetId={edgeTarget.id}
                      style={edgeTarget.style}
                      width={edgeTarget.width}
                      color={edgeTarget.color}
                    />
                  </div>
                ) : styleTarget !== undefined ? (
                  <div className="mm-split-side mm-split-style" data-mm-side="style">
                    <StylePanel
                      store={store}
                      state={state}
                      node={styleTarget.node}
                      depth={styleTarget.depth}
                      selectedIds={state.selectedIds}
                    />
                  </div>
                ) : (
                  /*
                   * 空态：面板开着但什么都没选（比如刚把选中的节点删了）。
                   *
                   * 不自动收起——那会让按钮的按下状态和面板可见性对不上；
                   * 留一块写着提示的区域，用户一眼就知道"要先选东西"。
                   */
                  <div
                    className="mm-split-side mm-split-style"
                    data-mm-side="style"
                    data-mm-style-empty="true"
                  >
                    <div className="mm-style" role="region" aria-label="属性">
                      <div className="mm-style-head">
                        <span className="mm-style-title">属性</span>
                        <div className="mm-grow" />
                        <button
                          type="button"
                          className="mm-btn"
                          data-icon="true"
                          data-mm-action="style-close"
                          onClick={() => store.hideStyle()}
                          title="收起属性抽屉"
                        >
                          ×
                        </button>
                      </div>
                      <p className="mm-style-hint">选中一个节点或一条连线，在这里改它的外观。</p>
                    </div>
                  </div>
                )
              ) : null}
            </div>
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
/**
 * 右侧栏里的导图 tab。
 *
 * 内容是完整的导图应用（列表页 + 画布带工具栏），宽度由右侧栏决定。
 * 自己持有一份 store：每个 tab 各自一份编辑状态，互不干扰。
 */
/**
 * 侧边栏入口按钮。
 *
 * 点它 = 在当前会话的右侧栏打开导图 tab。不做成"占满主区域"的主面板，
 * 因为那样会话界面会被卸载，右侧栏跟着消失。
 */
function MindmapLauncher({ ctx }: { ctx: ClientContext }): React.ReactElement {
  return React.createElement(
    "button",
    {
      type: "button",
      className: "mm-launch",
      "data-mm-action": "open-mindmap",
      title: "打开思维导图",
      onClick: () => {
        const right = (ctx as unknown as {
          sidebarRight?: { openTab: (kind: string) => void };
        }).sidebarRight;
        right?.openTab(MINDMAP_TAB_ID);
      },
    },
    React.createElement(MindmapIcon, { size: 16 }),
    React.createElement("span", null, "思维导图"),
  );
}

function MindmapTab({ store }: { store: MindmapStore }): React.ReactElement {
  return React.createElement(MindMapApp, { store });
}


export function apply(ctx: ClientContext): void {
  const slots = ctx.slots;
  if (slots === undefined) {
    console.warn("[" + PLUGIN_ID + "] slots 服务不可用，界面未注册");
    return;
  }

  /*
   * 全局唯一的 store：右侧 tab 和调试句柄共用同一个实例。
   *
   * 早先 main 面板和右侧 tab 各建一个，导致"状态是 edit、界面还停在列表"
   * 这种鬼打墙——两边看的根本不是同一份数据。
   */
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

  /*
   * 不再注册 `main` 面板。
   *
   * 方案 B 下导图只在右侧栏的 tab 里出现。保留 main 会带来两个问题：
   *   ① 两处各自 createStore()，调试句柄和实际渲染的可能不是同一个 store
   *      （现象：状态显示 edit，界面还停在列表）；
   *   ② 占满主区域会把会话界面换掉，右侧栏随之失去挂载点。
   */
  /*
   * 不再往左侧边栏注册任何东西。
   *
   * 左侧是"切换主面板"的语义——点它会占满主区域、把会话界面换掉，
   * 右侧抽屉随之失去挂载点。导图的入口在右侧抽屉首页的卡片里
   * （见 aiTab.ts 的 guide），和「图像工作台」一致。
   */

  /*
   * 注册右侧抽屉的 tab：先声明类型，再挂面板。
   *
   * 两步缺一不可——只注册类型不挂 body，openTab 会开出空白页；
   * 只挂 body 不注册类型，openTab 直接找不到这个 kind。
   */
  const rightTabs = (ctx as unknown as {
    sidebarRightTabs?: { register: (def: unknown) => () => void };
  }).sidebarRightTabs;

  /*
   * 暴露一个明确的全局句柄：斜杠命令、调试和将来的 AI 工具都要能打开这个抽屉，
   * 但它们拿不到 client 上下文的 ctx。比层层传 props 干净。
   */
  try {
    (window as unknown as { __dshSidebarRight?: unknown }).__dshSidebarRight = {
      openTab: (kind: string) => {
        const right = (ctx as unknown as { sidebarRight?: { openTab: (k: string) => void } }).sidebarRight;
        right?.openTab(kind);
      },
    };
  } catch {
    /* 非浏览器环境忽略 */
  }

  if (rightTabs !== undefined) {
    ctx.effect(() => {
      const dispose = rightTabs.register(mindmapTabDefinition());
      return () => {
        if (typeof dispose === "function") dispose();
      };
    }, "mindmap tab type");

    slots.inject("sidebar.right.pane.tab", () => {
      let dispose: unknown;
      try {
        dispose = slots.register(
          {
            name: "sidebar.right.pane.tab",
            key: MINDMAP_TAB_ID,
            inject: () => ({ store }),
          },
          MindmapTab,
        );
      } catch (error) {
        console.error("[" + PLUGIN_ID + "] sidebar.right.pane.tab 注册失败：", error);
      }
      return () => {
        if (typeof dispose === "function")(dispose as () => void)();
      };
    });
  } else {
    console.warn("[" + PLUGIN_ID + "] sidebarRightTabs 服务不可用，导图抽屉未注册");
  }

  // 启动即拉一次列表：这样点开抽屉是热的，不用等首屏
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
    detachEdge: (id: string): boolean => store.detachEdge(id),
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
    toggleStyle: (): void => store.toggleStyle(),
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
