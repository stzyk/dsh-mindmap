/**
 * dsh-mindmap — 导图画布（Client 半区）。
 *
 * 交互模型选择：**大纲键盘流 + 画布**，而不是自由拖拽。
 *
 * 为什么不做拖拽连线：拖拽看起来"更像导图工具"，但真实使用里 90% 的动作是
 * "加一个想法 / 改一句话 / 挪一层"，全都要靠拖就是折磨。这里把每个结构动作
 * 都绑到键盘上（Tab 缩进、Enter 加兄弟、Backspace 删），指针只负责选中。
 * 键盘流的好处：手不离主键位区，加十个节点只要十次 Enter。
 *
 * 键盘布局（与 XMind / Workflowy / 幕布一致，学过任何一家的用户零学习成本）：
 *   Enter            在选中节点后加一个同级节点，并进入编辑
 *   Tab              选中节点缩进成前一个兄弟的子节点
 *   Shift+Tab        取消缩进
 *   Alt+↑ / Alt+↓    在兄弟之间上移 / 下移
 *   Backspace/Delete 删除选中节点（根节点不可删）
 *   空格 / F2        编辑选中节点文字
 *   ↑ ↓ ← →         在树上移动光标（← 到父节点，→ 到第一个子节点）
 *   Esc              退出编辑 / 取消选中
 *
 * 编辑态用 textarea 的兄弟实现（input），Enter 提交并继续加节点的行为由
 * 外层 onKeyDown 接管，所以"打字 → Enter → 下一个"是一条连贯的路径。
 */

import * as React from "react";

import { layoutForest, layoutTree, linkPath, LAYOUT, type Layout, type TextMeasurer } from "../core/layout.ts";
import {
  attachImage,
  clearAllPositions,
  countNodes,
  detachImage,
  replaceImage,
  setImageCaption,
  hasManualPositions,
  insertChild,
  insertSibling,
  maxDepth,
  moveSibling,
  indentNode,
  locate,
  outdentNode,
  pathTo,
  removeNode,
  setPosition,
  setText,
  toggleCollapse,
  type MindDoc,
  type MindLink,
  type MindNode,
} from "../core/tree.ts";
import type { MindmapStore, ViewState } from "./store.ts";
import { paletteOf } from "../core/style.ts";
import { NodeTooltip, useNodeTooltip } from "./NodeTooltip.tsx";
import { NodePictures } from "./NodeImage.tsx";
import { Lightbox, type LightboxTarget } from "./Lightbox.tsx";
import { uploadImage } from "./images.ts";
import { loadView, saveView } from "./viewState.ts";

/** 组件 props：store + 当前视图状态。 */
interface CanvasProps {
  store: MindmapStore;
  state: ViewState;
}

/** 键盘移动方向。 */
type Move = "up" | "down" | "left" | "right";

/**
 * 计算下一个选中节点（方向移动）。
 *
 * 语义按"读树"的方式而不是"读屏幕"：
 *   left  → 父节点（回到上一级）
 *   right → 第一个子节点（进入下一级；已收起则先展开）
 *   up/down → 兄弟之间；边界时跳到堂兄弟（跨过父节点），这是大纲工具
 *             让人能一口气扫完整张图的关键，只在兄弟里转圈会很憋。
 */
export function nextSelection(root: MindNode, currentId: string, move: Move): string | undefined {
  const trail = pathTo(root, currentId);
  if (trail.length === 0) return undefined;
  const node = trail[trail.length - 1];
  const parent = trail.length > 1 ? trail[trail.length - 2] : undefined;

  if (move === "left") return parent?.id;

  if (move === "right") {
    if (node.collapsed === true || node.children.length === 0) return undefined;
    return node.children[0].id;
  }

  if (parent === undefined) return undefined;
  const index = parent.children.indexOf(node);
  const target = index + (move === "down" ? 1 : -1);
  if (target >= 0 && target < parent.children.length) return parent.children[target].id;

  // 越过父级：跳父节点的相邻兄弟（即"堂兄弟"）
  const grand = pathTo(root, parent.id);
  const grandParent = grand.length > 1 ? grand[grand.length - 2] : undefined;
  if (grandParent === undefined) return undefined;
  const parentIndex = grandParent.children.indexOf(parent);
  const cousinIndex = parentIndex + (move === "down" ? 1 : -1);
  const cousin = grandParent.children[cousinIndex];
  return cousin?.id;
}

/**
 * 造一个基于 canvas measureText 的真实测量函数。
 *
 * 为什么不用字符估算：估算对西文还行，对中日韩文字会偏窄约 8%——
 * 截图里 root 的"冒烟测试导图"就是这么被截成"冒烟测试…"的。
 * 浏览器里既然能拿到真实字体度量，就不要再猜。
 *
 * canvas 只建一次并复用：每次测量都建一个 context 会让长文档的布局
 * 明显变慢（60 节点 × 每次重渲染）。
 */
function createMeasurer(): TextMeasurer {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  // 与 styles.ts 的 .mm-node 保持一致的字体栈
  const family = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif';
  const cache = new Map<string, number>();

  return (text, fontSize, bold) => {
    if (ctx === null) return Math.round(text.length * fontSize * 0.8);
    const key = String(fontSize) + (bold ? "b" : "") + "\u0000" + text;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    ctx.font = (bold ? "600 " : "") + String(fontSize) + "px " + family;
    const width = ctx.measureText(text.length > 0 ? text : "空节点").width;
    // 缓存上限：长会话里反复改字不该让这个 Map 无限长
    if (cache.size > 4000) cache.clear();
    cache.set(key, width);
    return width;
  };
}

/**
 * 缩放范围与档位。
 *
 * 下限 25% 是为了"看清整张图的全貌"（本项目 56 节点的图约 3000px 宽，
 * 25% 时刚好一屏放得下）；上限 300% 够看清最小的字号。
 * 档位用固定序列而不是每次乘 1.2：连续点几次后能回到 100%，
 * 而不是停在 121.55% 这种数上。
 */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

/** 画布组件。 */
export function MindMapCanvas({ store, state }: CanvasProps): React.ReactElement {
  const doc = state.doc;
  const selectedId = state.selectedId;
  const selectedIds = state.selectedIds;
  const editingId = state.editingId;
  const [zoom, setZoom] = React.useState(1);
  /**
   * 虚拟留白（画布单位）：内容四周各留这么多可滚动空间。
   *
   * 为什么要它：滚动条的范围必须比内容大，否则"画布被内容卡死"；
   * 而纯 transform 平移又会**丢掉滚动条**——用户失去了最熟悉的导航方式。
   * 折中做法是让滚动范围 = 内容 + 两侧留白，两个需求同时满足。
   *
   * 4000px 在 100% 缩放下相当于四个屏幕宽，实际使用基本等同于无限。
   */
  const PAD = 4000;

  /** 是否正在平移（用于切换光标 + 决定要不要挂 document 级兜底）。 */
  /** 编辑中的草稿文字。 */
  const [draft, setDraft] = React.useState("");

  /** 画布 DOM：坐标换算与命中测试都用它。 */
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  /** 滚动视口。 */
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  /** 节点文字编辑框。 */
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  /** 替换图片用的隐藏文件选择器（和"添加图片"的分开，避免目标混淆）。 */
  const replaceInputRef = React.useRef<HTMLInputElement | null>(null);
  /** 拖动刚结束时浏览器补发的那次 click 要吞掉，否则会改掉选中态。 */
  const suppressClickRef = React.useRef(false);
  /** "直接打字进入编辑"时暂存的首字符。 */
  const pendingCharRef = React.useRef<string | null>(null);

  /** 图片灯箱。 */
  const [lightbox, setLightbox] = React.useState<LightboxTarget | null>(null);
  /** 是否正有文件拖到画布上（高亮提示）。 */
  const [dragOver, setDragOver] = React.useState(false);

  /** 框选虚线框。 */
  const [marquee, setMarquee] = React.useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const marqueeRef = React.useRef<{
    startX: number;
    startY: number;
    pointerId: number;
    additive: boolean;
  } | null>(null);

  /** 节点拖动预览（松手才写回文档）。 */
  const [dragPreview, setDragPreview] = React.useState<{ dx: number; dy: number } | null>(null);
  const [dragIds, setDragIds] = React.useState<string[]>([]);
  const dragRef = React.useRef<{
    id: string;
    ids: string[];
    startX: number;
    startY: number;
    pointerId: number;
    /** 是否已经超过拖动阈值。 */
    active: boolean;
  } | null>(null);

  /** 文字测量器（挂一次，避免每帧新建 canvas 上下文）。 */
  const measurerRef = React.useRef<TextMeasurer | null>(null);
  if (measurerRef.current === null) measurerRef.current = createMeasurer();

  /** 节点悬停提示。 */
  const tooltip = useNodeTooltip(true);

  /**
   * 布局结果。
   *
   * 多主题时容器根不渲染，只排版它的 children（各个主题）；
   * 单主题仍然走原来的 layoutTree，行为完全不变。
   */
  const layout: Layout | null = React.useMemo(() => {
    if (doc === null) return null;
    const options = { measure: measurerRef.current ?? undefined };
    if (doc.multiTheme === true) return layoutForest(doc.root.children, options);
    return layoutTree(doc.root, options);
  }, [doc?.root, doc]);

  /** 选中节点在布局里的那一份。 */
  const selectedNode = React.useMemo(() => {
    if (layout === null || selectedId === null) return null;
    return layout.nodes.find((node) => node.id === selectedId) ?? null;
  }, [layout, selectedId]);

  /**
   * 当前被**显式选中**的连线。
   *
   * 只认 selectedEdgeId，不再回退到"选中节点就带出它的入边"：
   * 选中节点时用户要改的是节点（文字、样式、图片），
   * 线上却冒出一个删除按钮和两个端点手柄，很容易误删。
   * 线是独立对象，想改线就点线本身。
   */
  const selectedIncomingLink = React.useMemo(() => {
    if (layout === null || state.selectedEdgeId === null) return null;
    return layout.links.find((link) => link.toId === state.selectedEdgeId) ?? null;
  }, [layout, state.selectedEdgeId]);

  /** 选中节点的祖先 id 集合：用于路径高亮。 */
  const pathIds = React.useMemo(() => {
    if (doc === null || selectedId === null) return new Set<string>();
    return new Set(pathTo(doc.root, selectedId).map((node) => node.id));
  }, [doc, selectedId]);

  /**
   * 编辑框宽度：跟着内容走，下限取节点自己的宽度。
   * 固定宽度会让短节点被撑出一个明显更宽的框。
   */
  const editorWidth = React.useMemo(() => {
    const measure = measurerRef.current;
    const measured = measure === null ? draft.length * 13 : measure(draft, 13, false);
    const nodeWidth = layout?.nodes.find((node) => node.id === editingId)?.width ?? 92;
    return Math.round(Math.min(360, Math.max(nodeWidth, measured + 18)));
  }, [draft, editingId, layout]);

  /** 让画布拿到键盘焦点。 */
  const focusCanvas = React.useCallback(() => {
    canvasRef.current?.focus();
  }, []);

  /** 把节点滚进视野（只在真的看不见时才挪）。 */
  const scrollNodeIntoView = React.useCallback((id: string, pad = 40): void => {
    const scroller = scrollRef.current;
    const canvas = canvasRef.current;
    if (scroller === null || canvas === null) return;
    const el = canvas.querySelector<HTMLElement>('[data-node-id="' + CSS.escape(id) + '"]');
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (rect.top < view.top + pad) scroller.scrollTop -= view.top + pad - rect.top;
    else if (rect.bottom > view.bottom - pad) scroller.scrollTop += rect.bottom - (view.bottom - pad);
    if (rect.left < view.left + pad) scroller.scrollLeft -= view.left + pad - rect.left;
    else if (rect.right > view.right - pad) scroller.scrollLeft += rect.right - (view.right - pad);
  }, []);

  /** 选中并聚焦某个节点。 */
  const focusNode = React.useCallback(
    (id: string | undefined) => {
      if (id === undefined) return;
      store.select(id);
      requestAnimationFrame(() => {
        focusCanvas();
        scrollNodeIntoView(id);
      });
    },
    [store, focusCanvas, scrollNodeIntoView],
  );

  /** 搜索框是否打开 / 当前关键词。 */
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  /** 当前停在第几个匹配（Enter 循环）。 */
  const [matchIndex, setMatchIndex] = React.useState(0);

  /**
   * 匹配到的节点 id（按文档顺序）。
   *
   * 只搜正文，不搜备注：备注不进画布显示，搜到了也看不见，
   * 用户会以为定位失败。
   */
  const matchIds = React.useMemo(() => {
    if (doc === null) return [];
    const needle = searchQuery.trim().toLowerCase();
    if (needle.length === 0) return [];
    const hits: string[] = [];
    const walk = (node: MindNode): void => {
      if (node.text.toLowerCase().includes(needle)) hits.push(node.id);
      for (const child of node.children) walk(child);
    };
    walk(doc.root);
    return hits;
  }, [doc, searchQuery]);

  /** 跳到第 index 个匹配：选中 + 滚进视野。 */
  const gotoMatch = React.useCallback(
    (index: number) => {
      if (matchIds.length === 0) return;
      const wrapped = ((index % matchIds.length) + matchIds.length) % matchIds.length;
      setMatchIndex(wrapped);
      const id = matchIds[wrapped]!;
      store.select(id);
      // 等选中生效、节点渲染出来再滚
      requestAnimationFrame(() => scrollNodeIntoView(id, 80));
    },
    [matchIds, store, scrollNodeIntoView],
  );

  /** 关键词变化时自动跳到第一个匹配。 */
  React.useEffect(() => {
    if (!searchOpen) return;
    setMatchIndex(0);
    if (matchIds.length > 0) gotoMatch(0);
    // gotoMatch 依赖 matchIds，这里只跟着关键词走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchOpen]);

  /**
   * 缩放，锚在给定屏幕点（默认视口中心）。
   */
  const applyZoom = React.useCallback(
    (next: number, anchorX?: number, anchorY?: number): void => {
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
      const wrap = scrollRef.current;
      if (wrap === null) {
        setZoom(clamped);
        return;
      }
      if (clamped === zoom) return;
      const rect = wrap.getBoundingClientRect();
      const px = anchorX === undefined ? rect.width / 2 : anchorX - rect.left;
      const py = anchorY === undefined ? rect.height / 2 : anchorY - rect.top;
      // 锚点在画布坐标系里的位置（缩放前后不变）
      const contentX = (wrap.scrollLeft + px) / zoom;
      const contentY = (wrap.scrollTop + py) / zoom;
      setZoom(clamped);
      requestAnimationFrame(() => {
        const box = scrollRef.current;
        if (box === null) return;
        box.scrollLeft = contentX * clamped - px;
        box.scrollTop = contentY * clamped - py;
      });
    },
    [zoom],
  );

  /** 按固定档位缩放（跳档而不是乘系数，才能回到 100%）。 */
  const zoomStep = React.useCallback(
    (dir: -1 | 1): void => {
      const current = zoom;
      if (dir > 0) {
        const next = ZOOM_STEPS.find((step) => step > current + 0.001);
        applyZoom(next ?? ZOOM_MAX);
      } else {
        const lower = ZOOM_STEPS.filter((step) => step < current - 0.001);
        applyZoom(lower.length > 0 ? lower[lower.length - 1]! : ZOOM_MIN);
      }
    },
    [zoom, applyZoom],
  );

  /**
   * 打开文档时恢复上次的视口位置（滚动 + 缩放）。
   *
   * 放在 layout 算好之后再执行：滚动范围要等画布尺寸定了才有效，
   * 否则设进去的 scrollLeft 会被浏览器夹到 0。
   */
  const restoredDocRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (doc === null || layout === null) return;
    // 同一份文档只恢复一次：否则每次重排/编辑都会把视图拽回去
    if (restoredDocRef.current === doc.id) return;
    restoredDocRef.current = doc.id;
    const saved = loadView(doc.id);
    if (saved === undefined) return;
    // 缩放先落，再等一帧让画布按新尺寸重排后设置滚动位置
    setZoom(saved.zoom);
    requestAnimationFrame(() => {
      const wrap = scrollRef.current;
      if (wrap === null) return;
      wrap.scrollLeft = saved.left;
      wrap.scrollTop = saved.top;
    });
  }, [doc?.id, layout]);

  /**
   * 记录视口位置（防抖 500ms）。
   *
   * 拖滚动条/平移是高频动作，每次写 localStorage 既浪费又卡；
   * 停下来半秒再写就够用了。
   */
  React.useEffect(() => {
    if (doc === null) return;
    const wrap = scrollRef.current;
    if (wrap === null) return;
    const docId = doc.id;
    let timer: number | undefined;
    const record = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const box = scrollRef.current;
        if (box === null) return;
        saveView(docId, {
          left: Math.round(box.scrollLeft),
          top: Math.round(box.scrollTop),
          zoom: zoomRef.current,
        });
      }, 500);
    };
    wrap.addEventListener("scroll", record, { passive: true });
    // 缩放变化不触发 scroll，单独记一次
    record();
    return () => {
      wrap.removeEventListener("scroll", record);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [doc?.id, zoom]);

  /** 当前缩放的引用（给只挂一次的 wheel 监听器读）。 */
  const zoomRef = React.useRef(zoom);
  React.useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  const applyZoomRef = React.useRef(applyZoom);
  React.useEffect(() => {
    applyZoomRef.current = applyZoom;
  }, [applyZoom]);

  /**
   * Ctrl/Cmd + 滚轮缩放，锚在鼠标位置。
   *
   * 用原生 addEventListener 而不是 React 的 onWheel：React 把 wheel 注册成
   * passive，里面 preventDefault 会被忽略，浏览器会顺手把宿主页面缩放掉。
   */
  React.useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const step = event.deltaY < 0 ? 1 : -1;
      const steps = ZOOM_STEPS;
      const current = zoomRef.current;
      let next = current;
      if (step > 0) {
        next = steps.find((item) => item > current + 0.001) ?? ZOOM_MAX;
      } else {
        const lower = steps.filter((item) => item < current - 0.001);
        next = lower.length > 0 ? lower[lower.length - 1]! : ZOOM_MIN;
      }
      applyZoomRef.current(next, event.clientX, event.clientY);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  /** 选中节点变化时把它滚进视野（只在看不见时挪，避免打断用户）。 */
  React.useEffect(() => {
    if (selectedId === null) return;
    scrollNodeIntoView(selectedId);
  }, [selectedId, scrollNodeIntoView]);

  /** 编辑态变化时也滚一次（编辑框比节点宽）。 */
  React.useEffect(() => {
    if (editingId === null) return;
    scrollNodeIntoView(editingId, 60);
  }, [editingId, scrollNodeIntoView]);

  /**
   * 编辑框按内容自动增高。
   *
   * 先把高度重置成 auto 再读 scrollHeight，否则会拿到上一次的高度、
   * 越缩越小（经典坑）。`+2` 是给边框留的余量。
   */
  React.useLayoutEffect(() => {
    if (editingId === null) return;
    const input = inputRef.current;
    if (input === null) return;
    input.style.height = "auto";
    input.style.height = String(input.scrollHeight + 2) + "px";
  }, [editingId, draft]);

  /** 编辑框初始化：把草稿同步成当前文字，并处理"打字即编辑"的首字符。 */
  React.useLayoutEffect(() => {
    if (editingId === null) return;
    if (doc === null) return;
    const found = locate(doc.root, editingId);
    if (found === undefined) return;
    const pending = pendingCharRef.current;
    pendingCharRef.current = null;
    if (pending !== null) {
      // 直接打字进入编辑：首字符顶替原文字
      setDraft(pending);
      return;
    }
    setDraft(found.node.text);
  }, [editingId]);

  /**
   * 进入编辑态时把焦点交给编辑框，光标放到末尾。
   *
   * 少了这一步，Enter / Escape / 输入法全都打不到 textarea：
   * 按键落在画布上，editingId 永远退不出去，之后所有键盘操作都被
   * `if (editingId !== null) return` 吞掉（表现为"快捷键全失效"）。
   */
  React.useEffect(() => {
    if (editingId === null) return;
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    const len = input.value.length;
    input.setSelectionRange(len, len);
  }, [editingId]);

  const [panning, setPanning] = React.useState(false);
  /** 平移拖拽的起始状态。 */
  const panRef = React.useRef<{
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    pointerId: number;
  } | null>(null);

  /**
   * 右键 / 中键按下开始平移。
   *
   * 平移靠改滚动位置实现（画布四周有 PAD 留白，所以滚得比内容远得多），
   * 这样系统原生滚动条同时可用——用户既有的导航习惯不丢。
   */
  const onWrapPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 2 && event.button !== 1) return;
    const wrap = scrollRef.current;
    if (wrap === null) return;
    // 阻止默认行为：右键会选中文本，中键会触发浏览器的"自动滚动"模式
    event.preventDefault();
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: wrap.scrollLeft,
      startTop: wrap.scrollTop,
      pointerId: event.pointerId,
    };
    setPanning(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 不支持捕获时退化为普通事件流 */
    }
  }, []);

  const onWrapPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan === null || event.pointerId !== pan.pointerId) return;
    const wrap = scrollRef.current;
    if (wrap === null) return;
    // 鼠标往左上拖 -> 内容跟着走 -> 视口往右下看 -> scroll 增大
    wrap.scrollLeft = pan.startLeft - (event.clientX - pan.startX);
    wrap.scrollTop = pan.startTop - (event.clientY - pan.startY);
  }, []);

  const onWrapPointerUp = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan === null || event.pointerId !== pan.pointerId) return;
    panRef.current = null;
    setPanning(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 没捕获成功时释放会抛错，忽略 */
    }
  }, []);

  /** 正在编辑文字的连线（存子节点 id）。 */
  const [edgeEditId, setEdgeEditId] = React.useState<string | null>(null);
  const [edgeDraft, setEdgeDraft] = React.useState("");
  /** 正在编辑文字的自由连线 id。 */
  const [freeLinkEditId, setFreeLinkEditId] = React.useState<string | null>(null);
  /** 正在编辑说明的图片。 */
  const [captionEdit, setCaptionEdit] = React.useState<{
    nodeId: string;
    imageId: string;
    text: string;
  } | null>(null);
  /** 正在替换的那张图片（点 ↻ 后等用户选文件）。 */
  const replaceTargetRef = React.useRef<{ nodeId: string; imageId: string } | null>(null);

  /**
   * 拖动连线改关联。
   *
   * `end` 决定虚线从哪一头画：拖子端就从父端画起，反之亦然。
   * `moved` 用来区分"点一下线"（选中并编辑）和"拖线"（改关联）。
   */
  const [relink, setRelink] = React.useState<{
    childId: string;
    fromId: string;
    end: "parent" | "child";
    x: number;
    y: number;
  } | null>(null);
  /** 按下了某条连线但还没超过拖动阈值时的信息。 */
  const [relinkPending, setRelinkPending] = React.useState<{
    childId: string;
    fromId: string;
    end: "parent" | "child";
  } | null>(null);
  const relinkPendingRef = React.useRef<typeof relinkPending>(null);
  relinkPendingRef.current = relinkPending;
  const relinkRef = React.useRef<{
    childId: string;
    end: "parent" | "child";
    fromId: string;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  /** 正在从节点拉出一条新关系线。 */
  const [linkDrag, setLinkDrag] = React.useState<{ fromId: string; x: number; y: number } | null>(null);
  const linkDragRef = React.useRef<{ fromId: string; pointerId: number; moved: boolean } | null>(null);

  React.useEffect(() => {
    if (!panning) return;
    const move = (event: MouseEvent): void => {
      const pan = panRef.current;
      const wrap = scrollRef.current;
      if (pan === null || wrap === null) return;
      wrap.scrollLeft = pan.startLeft - (event.clientX - pan.startX);
      wrap.scrollTop = pan.startTop - (event.clientY - pan.startY);
    };
    const stop = (): void => {
      panRef.current = null;
      setPanning(false);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
    // 拖到窗口外松手也要收尾
    window.addEventListener("blur", stop);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [panning]);

  /**
   * 中键按下时阻止浏览器的默认行为。
   *
   * 光在 pointerdown 里 preventDefault 不够：Windows 上的 Chrome / Edge
   * 会在 **mousedown** 阶段进入"自动滚动"模式（出现那个上下箭头的小圆圈），
   * 一旦进入，后续的 pointermove 就被它接管，平移会失效。
   * 所以必须在 mousedown 上再拦一次。
   *
   * 同时也拦 auxclick：中键抬起会触发它，某些浏览器会在那里做默认动作。
   */
  const onWrapMouseDown = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 1) event.preventDefault();
  }, []);

  const onWrapAuxClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 1) event.preventDefault();
  }, []);

  /**
   * 屏蔽画布上的浏览器右键菜单。
   *
   * 右键已经用作平移手势，再弹出"另存为/检查元素"会打断操作。
   * 画布本身没有任何需要浏览器菜单的场景。
   */
  const onWrapContextMenu = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  /* ---------------------------------------------------------------- *
   * 连线：文字与改关联
   * ---------------------------------------------------------------- */

  /** 连线文字提交。 */
  const commitEdgeLabel = React.useCallback(() => {
    const id = edgeEditId;
    setEdgeEditId(null);
    if (id === null) return;
    store.setEdgeLabel(id, edgeDraft);
  }, [edgeEditId, edgeDraft, store]);

  /**
   * 按下连线，开始"拖动改关联"。
   *
   * 连线由父子关系隐式推导，所以"把线连到别的节点" = 把这条线指向的
   * **子节点**换个父节点。拖的是子端，语义最直观：线跟着节点走。
   */
  /**
   * 开始"拖动连线改关联"。
   *
   * 三个入口共用：连线本体、父端手柄、子端手柄。
   * `end` 只影响虚线的起点画在哪一头——结果都是"把 childId 挂到松手处的节点下"。
   */
  const beginRelink = React.useCallback(
    (
      event: React.PointerEvent<Element>,
      link: { fromId: string; toId: string },
      end: "parent" | "child",
    ) => {
      if (event.button !== 0) return;
      // 别让画布把这次按下当成框选
      event.stopPropagation();
      event.preventDefault();
      /*
       * 先只记下起点，**不立刻进入拖动**。
       *
       * 因为同一次按下可能只是"点一下这条边"（想选中它、编辑它的文字）。
       * 只有指针移动超过阈值才算拖动，否则松手时按点击处理——
       * 这是"既能点又能拖"的标准做法，和节点拖动用的是同一套。
       */
      relinkRef.current = {
        childId: link.toId,
        end,
        fromId: link.fromId,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      setRelinkPending({ childId: link.toId, fromId: link.fromId, end });
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* 不支持捕获时退化为普通事件流 */
      }
    },
    [],
  );

  const onLinkPointerDown = React.useCallback(
    (event: React.PointerEvent<SVGPathElement>, link: { fromId: string; toId: string }) => {
      beginRelink(event, link, "child");
    },
    [beginRelink],
  );

  /** 拖动连线时更新跟随的虚线。 */
  const onLinkPointerMove = React.useCallback(
    (event: React.PointerEvent<Element>) => {
      const state_ = relinkRef.current;
      if (state_ === null || event.pointerId !== state_.pointerId) return;
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / zoom;
      const y = (event.clientY - rect.top) / zoom;
      // 超过 3px 才算拖动（和节点拖动同一个阈值）
      if (!state_.moved) {
        const dx = event.clientX - state_.startX;
        const dy = event.clientY - state_.startY;
        if (dx * dx + dy * dy < 9) return;
        state_.moved = true;
      }
      setRelink((current) => {
        if (current !== null) return { ...current, x, y };
        const pending = relinkPendingRef.current;
        return pending === null ? null : { ...pending, x, y };
      });
    },
    [zoom],
  );

  /**
   * 松开连线：看落点在哪个节点上，改挂过去。
   *
   * 用 `elementFromPoint` 做命中测试，而不是给每个节点挂 onPointerEnter：
   * 拖动期间指针被连线捕获了，节点的 enter/leave 不会正常触发。
   */
  const onLinkPointerUp = React.useCallback(
    (event: React.PointerEvent<Element>) => {
      const state_ = relinkRef.current;
      if (state_ === null || event.pointerId !== state_.pointerId) return;
      const moved = state_.moved;
      relinkRef.current = null;
      relinkPendingRef.current = null;
      setRelink(null);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }

      /*
       * 没超过阈值 = 一次点击：把这条边**选中**并直接打开文字编辑。
       *
       * 这就是"边是独立对象"的落点——点一下线就能操作它，
       * 不必先找到它的子节点。选中后两端手柄和删除按钮都会出现。
       */
      if (!moved) {
        store.selectEdge(state_.childId);
        const link = layout?.links.find((item) => item.toId === state_.childId);
        setEdgeDraft(link?.label ?? "");
        setEdgeEditId(state_.childId);
        return;
      }

      // 找指针下的节点（取第一个带 data-node-id 的祖先）
      const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const nodeEl = hit?.closest<HTMLElement>("[data-node-id]") ?? null;
      const targetId = nodeEl?.dataset.nodeId;
      if (targetId === undefined) {
        store.toast("松开在空白处，连线没有改变");
        return;
      }
      /*
       * 两端语义不同（用户反馈 v0.16.0）：
       *   - 拖**尾端**（靠近子节点那头）-> 改这条线连到谁：
       *     `1 -> 2` 拖到 3 变成 `1 -> 3`，原节点 2 升格成自由主题留在原地。
       *     之前这里和父端一样处理，结果变成 `2 -> 3`，和直觉相反。
       *   - 拖**父端**（靠近父节点那头）-> 把这个节点挂到落点下面：
       *     `1 -> 2` 拖父端到 3 变成 `3 -> 2`。
       */
      if (state_.end === "child") {
        const at = layout?.nodes.find((node) => node.id === state_.childId);
        store.repointEdge(
          state_.childId,
          targetId,
          at === undefined ? undefined : { x: at.x, y: at.y },
        );
        return;
      }
      store.reparent(state_.childId, targetId);
    },
    [store, layout],
  );

  /**
   * 双击空白处 -> 在**鼠标位置**新增一个中心主题。
   *
   * 挂在**外层滚动容器**上而不是 .mm-canvas：.mm-canvas 的尺寸等于布局尺寸
   * （只有节点那一片），用户在布局范围之外的空白处双击时，事件根本到不了它。
   * 而"空白区域"在视觉上指的是整个可见画布。
   *
   * 为什么判断"冒泡到这里就是空白"：节点、连线、连线文字的双击都各自
   * stopPropagation 了（进入编辑 / 改连线文字），所以能冒泡到画布的
   * 双击只可能来自空白区域。这里仍然逐个 closest 兜一道，
   * 免得以后哪个子元素忘了挡事件就误建主题。
   *
   * 单主题导图第一次双击时，addTheme 会把当前主题变成第一个、
   * 再追加一个新的——和点工具栏「＋ 主题」走的是同一条路径。
   */
  const onCanvasDoubleClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(".mm-node") !== null ||
        target.closest(".mm-link-hit") !== null ||
        target.closest(".mm-edge-label") !== null ||
        target.closest(".mm-edge-input") !== null ||
        target.closest(".mm-marquee") !== null
      ) {
        return;
      }
      event.preventDefault();
      /*
       * 换算成**画布坐标**再交给 store：画布有 transform: scale(zoom)，
       * 且 transform-origin 在左上角，所以先减去画布元素的屏幕位置再除以缩放。
       * 直接用 clientX/Y 的话，缩放和滚动之后位置会偏。
       */
      const canvas = canvasRef.current;
      if (canvas === null) {
        store.addTheme();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      store.addTheme({
        x: Math.round((event.clientX - rect.left) / zoom),
        y: Math.round((event.clientY - rect.top) / zoom),
      });
    },
    [store, zoom],
  );

  /**
   * 点空白处 -> 取消所有选中（节点 / 连线 / 关系线）。
   *
   * 挂在**外层容器**上：布局范围之外的空白属于 .mm-canvas-wrap，
   * 而清除逻辑原来只挂在 .mm-canvas 上，于是"点画布外的大片空白"
   * 什么都不会发生——用户会觉得选中卡住了。
   *
   * 节点 / 连线自己会 stopPropagation，这里再逐个 closest 兜一道。
   */
  const onWrapClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(".mm-node") !== null ||
        target.closest(".mm-link-hit") !== null ||
        target.closest(".mm-edge-label") !== null ||
        target.closest(".mm-edge-input") !== null ||
        target.closest(".mm-link-dot") !== null
      ) {
        return;
      }
      // 框选/拖动刚结束的那一次 click 不算"点空白"
      if (suppressClickRef.current) return;
      store.selectEdge(null);
      store.selectFreeLink(null);
      store.select(null);
    },
    [store],
  );

  /**
   * 空白处按下 -> 开始框选。
   *
   * 挂在画布容器上而不是单独加一层遮罩：遮罩会挡住节点的指针事件，
   * 也就要额外处理层级和穿透，反而更复杂。这里用 `event.target` 判断
   * 是否点在节点上——点在节点上时交给节点的处理函数。
   */
  const onCanvasPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (editingId !== null) return;
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      // 点在节点/折叠按钮/图片上时不框选
      if (target.closest(".mm-node") !== null) return;
      if (target.closest(".mm-marquee") !== null) return;

      const canvas = canvasRef.current;
      if (canvas === null) return;
      const rect = canvas.getBoundingClientRect();
      // 屏幕坐标 -> 画布坐标（画布被 scale(zoom) 缩放过）
      const x = (event.clientX - rect.left) / zoom;
      const y = (event.clientY - rect.top) / zoom;

      marqueeRef.current = {
        startX: x,
        startY: y,
        pointerId: event.pointerId,
        // Shift/Cmd 时保留已有选中（追加框选）
        additive: event.shiftKey || event.metaKey || event.ctrlKey,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* 不支持捕获时退化为普通事件流 */
      }
    },
    [editingId, zoom],
  );

  /** 框选移动：更新虚线框。 */
  const onCanvasPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const marqueeState = marqueeRef.current;
      if (marqueeState === null || event.pointerId !== marqueeState.pointerId) return;
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / zoom;
      const y = (event.clientY - rect.top) / zoom;
      const left = Math.min(marqueeState.startX, x);
      const top = Math.min(marqueeState.startY, y);
      setMarquee({
        x: left,
        y: top,
        w: Math.abs(x - marqueeState.startX),
        h: Math.abs(y - marqueeState.startY),
      });
    },
    [zoom],
  );

  /**
   * 框选结束：选中与矩形相交的节点。
   *
   * 用"相交"而不是"完全包含"：用户框选时通常只想大致圈住一片，
   * 要求节点完全落在框里会让操作变得很难对准（尤其是大节点）。
   */
  const onCanvasPointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const marqueeState = marqueeRef.current;
      if (marqueeState === null || event.pointerId !== marqueeState.pointerId) return;
      marqueeRef.current = null;

      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* 没捕获成功时释放会抛错，忽略 */
      }

      const box = marquee;
      setMarquee(null);
      /*
       * 框选松手后浏览器还会补一个 click，它会冒泡到容器的"点空白清选中"。
       * 不挡的话刚框好的选中立刻被清掉（表现为"框选永远选不中"）。
       */
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (box === null || layout === null) return;

      // 太小的框当成"点空白处"：清空选中
      if (box.w < 4 && box.h < 4) {
        if (!marqueeState.additive) {
          store.selectEdge(null);
          store.selectFreeLink(null);
          store.select(null);
        }
        return;
      }

      const hit = layout.nodes
        .filter((node) => {
          return (
            node.x < box.x + box.w &&
            node.x + node.width > box.x &&
            node.y < box.y + box.h &&
            node.y + node.height > box.y
          );
        })
        .map((node) => node.id);

      if (hit.length === 0) {
        if (!marqueeState.additive) store.select(null);
        return;
      }
      if (marqueeState.additive) {
        store.selectMany([...state.selectedIds, ...hit]);
      } else {
        store.selectMany(hit);
      }
    },
    [marquee, layout, store, state.selectedIds],
  );

  /**
   * 节点上按下：选中 / 加选 / 开始拖动。
   *
   * 拖动用 3px 阈值区分"点击"和"拖拽"：没超过阈值就当点击（改选中态），
   * 超过了才进入拖动预览。
   */
  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>, nodeId: string) => {
      if (editingId !== null) return;
      if (event.button !== 0) return;

      const target = event.target as HTMLElement;
      // 折叠按钮上的按下不启动拖动
      if (target.closest(".mm-fold") !== null) return;

      const layoutNode = layout?.nodes.find((node) => node.id === nodeId);
      if (layoutNode === undefined) return;

      /*
       * Shift / Cmd / Ctrl + 点击 = 加选或减选，不启动拖动。
       * 必须挡住随后那次 click，否则刚加进去的选中会被重置成单选。
       */
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        event.preventDefault();
        store.toggleSelect(nodeId);
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        return;
      }

      // 点未选中的节点 = 改成单选；点已选中的保持多选，才能整组拖
      if (!selectedIds.includes(nodeId)) store.select(nodeId);
      const ids = selectedIds.includes(nodeId) ? selectedIds : [nodeId];

      dragRef.current = {
        id: nodeId,
        ids,
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId,
        active: false,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
    },
    [editingId, layout, store, selectedIds],
  );

  /** 节点拖动：超过阈值后进入预览。 */
  const onPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (dx * dx + dy * dy < 9) return;
      drag.active = true;
      setDragIds(drag.ids);
    }
    // 位移按缩放换算回画布坐标
    setDragPreview({ dx: dx / zoom, dy: dy / zoom });
  }, [zoom]);

  const onPointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;

      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* 没捕获成功时释放会抛错，忽略 */
      }

      // 没超过阈值 = 一次普通点击，什么都不改
      if (!drag.active) {
        setDragPreview(null);
        setDragIds([]);
        return;
      }

      const preview = dragPreview;
      setDragPreview(null);
      setDragIds([]);
      if (doc === null || preview === null) return;

      /*
       * 单个节点：直接设成预览坐标。
       * 多个节点：用**增量**平移整组——这样它们之间的相对位置不变，
       * 而不是全部叠到同一个坐标上。
       */
      /*
     * 拖动结束后按视觉上下顺序重排兄弟：用户摆出来的顺序就是他要的顺序，
     * 自动排版应该照着来，而不是照着"输入时的先后"。
     */
    store.sortByPosition();

    if (drag.ids.length === 1) {
        const layoutNode = layout?.nodes.find((node) => node.id === drag.id);
        if (layoutNode === undefined) return;
        const moved = setPosition(
          doc.root,
          drag.id,
          layoutNode.x + preview.dx,
          layoutNode.y + preview.dy,
        );
        if (moved === undefined) {
          store.toast("这个位置超出了可摆放范围", "error");
          return;
        }
        store.mutate(moved);
      } else {
        store.moveSelected(drag.ids, preview.dx, preview.dy, (id) => {
          const node = layout?.nodes.find((item) => item.id === id);
          return node === undefined ? undefined : { x: node.x, y: node.y };
        });
      }
      // 拖动结束后紧跟的 click 不该改选中态
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      /*
       * 拖动后不弹提示。
       *
       * 拖动是高频动作，每拖一次弹一条"已移动"是在制造噪音；
       * 而且「重新排版」按钮一直在操作条上，需要时看得见，不需要靠 toast 提醒。
       */
    },
    [doc, dragPreview, store, layout],
  );

  /** 指针被系统取消（来电、手势中断）：放弃这次拖动，不写回。 */
  const onPointerCancel = React.useCallback(() => {
    dragRef.current = null;
    setDragPreview(null);
  }, []);

  /** 隐藏的文件选择器。 */
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  /**
   * 把若干张图片加到当前选中节点。
   *
   * 逐张上传并逐张落树：一次加三张时如果第二张失败，前一张不该被回滚——
   * 用户看得见已经加上的那张，也算完成了一半。失败的那些单独提示。
   */
  const addImages = React.useCallback(
    async (files: File[]) => {
      if (doc === null) return;
      const nodeId = selectedId ?? doc.root.id;
      if (files.length === 0) return;

      let root = doc.root;
      let added = 0;
      const failures: string[] = [];

      for (const file of files) {
        try {
          const image = await uploadImage(file);
          const next = attachImage(root, nodeId, image);
          if (next === undefined) {
            failures.push(file.name + "（这个节点放不下更多图片了）");
            continue;
          }
          root = next;
          added += 1;
        } catch (error) {
          failures.push(file.name + "：" + (error as Error).message);
        }
      }

      if (added > 0) {
        store.mutate(root);
        store.select(nodeId);
        store.toast(added === 1 ? "已添加图片" : "已添加 " + String(added) + " 张图片");
      }
      if (failures.length > 0) {
        store.toast("有 " + String(failures.length) + " 张没加上：" + failures[0]!, "error");
      }
    },
    [doc, selectedId, store],
  );

  /**
   * 粘贴：从剪贴板取图片。
   *
   * 监听在 document 上而不是画布元素上：用户的实际操作是"在面板里 Ctrl+V"，
   * 焦点可能在标题栏或空白处。但仍然只在面板可见时生效（组件挂载着）。
   */
  React.useEffect(() => {
    if (editingId !== null) return; // 正在编辑文字时粘贴是粘贴文本
    const onPaste = (event: ClipboardEvent): void => {
      const items = event.clipboardData?.items;
      if (items === undefined || items === null) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file !== null && file.type.startsWith("image/")) files.push(file);
      }
      if (files.length === 0) return;
      // 有图片才拦截：否则会挡住用户往输入框粘文本
      event.preventDefault();
      void addImages(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addImages, editingId]);

  /** 拖入文件：dragover 必须 preventDefault，否则 drop 不触发。 */
  const onDragOver = React.useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }, []);

  const onDragLeave = React.useCallback(() => setDragOver(false), []);

  const onDrop = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      setDragOver(false);
      const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
      if (files.length === 0) return;
      event.preventDefault();
      void addImages(files);
    },
    [addImages],
  );

  /** 选文件后清空 value：否则连续选同一个文件不会触发 change。 */
  const onFilesPicked = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
      event.target.value = "";
      void addImages(files);
    },
    [addImages],
  );

  /** 移除选中节点里的最后一张图（删除按钮之外的一个快捷操作）。 */

  /** 删除节点上的某一张图片。 */
  const removeImage = React.useCallback(
    (nodeId: string, imageId: string) => {
      if (doc === null) return;
      const next = detachImage(doc.root, nodeId, imageId);
      if (next === undefined) {
        store.toast("这张图片已经不在了", "error");
        return;
      }
      store.mutate(next);
      store.toast("已删除这张图片");
    },
    [doc, store],
  );

  /**
   * 替换某一张图片。
   *
   * 记下目标后打开文件选择器，选完在 onReplacePicked 里真正换掉。
   * 不能直接在这里弹选择器：需要等用户选完才有文件。
   */
  const startReplaceImage = React.useCallback((nodeId: string, imageId: string) => {
    replaceTargetRef.current = { nodeId, imageId };
    replaceInputRef.current?.click();
  }, []);

  const onReplacePicked = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      const target = replaceTargetRef.current;
      replaceTargetRef.current = null;
      if (file === undefined || target === null || doc === null) return;
      try {
        const uploaded = await uploadImage(file);
        const next = replaceImage(doc.root, target.nodeId, target.imageId, {
          id: uploaded.id,
          type: uploaded.type,
          width: uploaded.width,
          height: uploaded.height,
          name: uploaded.name,
        });
        if (next === undefined) {
          store.toast("替换失败：这张图片已经不在了", "error");
          return;
        }
        store.mutate(next);
        store.toast("已替换图片");
      } catch (error) {
        store.toast((error as Error).message, "error");
      }
    },
    [doc, store],
  );

  /** 删除选中节点的入边：这个节点升格成自由主题。 */
  const removeIncomingEdge = React.useCallback(
    (childId: string) => {
      // 带上当前布局坐标：删掉连线后节点应该**原地**变成自由主题，不要跳走
      const at = layout?.nodes.find((node) => node.id === childId);
      store.detachEdge(childId, at === undefined ? undefined : { x: at.x, y: at.y });
    },
    [store, layout],
  );

  /**
   * 自由连线的画布几何。
   *
   * 连线不在树里，所以布局不知道它们。这里直接按两个节点的方框算：
   * 右边的节点在右侧就从左边连，反之亦然——不管谁在左谁在右都画得自然。
   */
  const freeLinks = React.useMemo(() => {
    if (layout === null || doc?.links === undefined) return [];
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const out: Array<{
      link: MindLink;
      d: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      midX: number;
      midY: number;
    }> = [];
    for (const link of doc.links) {
      const a = byId.get(link.from);
      const b = byId.get(link.to);
      if (a === undefined || b === undefined) continue;
      /*
       * 连接点固定在**左右两端**，不走上/下边。
       *
       * 早期按"横向距离占优还是纵向占优"决定连哪条边，于是两个上下相邻的
       * 节点会连成一条竖线，端点落在节点顶部和底部——用户明确要求
       * "接线的位置不能在节点的上下位置"，所以一律走左右边。
       */
      const acx = a.x + a.width / 2;
      const acy = a.y + a.height / 2;
      const bcx = b.x + b.width / 2;
      const bcy = b.y + b.height / 2;
      const dx = bcx - acx;
      const forward = dx >= 0;
      const x1 = forward ? a.x + a.width : a.x;
      const y1 = acy;
      const x2 = forward ? b.x : b.x + b.width;
      const y2 = bcy;
      const midX = x1 + (x2 - x1) * 0.55;
      const d = "M " + String(x1) + " " + String(y1) +
          " C " + String(midX) + " " + String(y1) + ", " + String(midX) + " " + String(y2) +
          ", " + String(x2) + " " + String(y2);
      out.push({
        link,
        d,
        x1,
        y1,
        x2,
        y2,
        midX: (x1 + x2) / 2,
        midY: (y1 + y2) / 2,
      });
    }
    return out;
  }, [layout, doc?.links]);

  /** 从节点拉出新连线：按下小圆点。 */
  const onLinkDotPointerDown = React.useCallback(
    (event: React.PointerEvent<Element>, fromId: string) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      linkDragRef.current = { fromId, pointerId: event.pointerId, moved: false };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
    },
    [],
  );

  const onLinkDotPointerMove = React.useCallback(
    (event: React.PointerEvent<Element>) => {
      const state_ = linkDragRef.current;
      if (state_ === null || event.pointerId !== state_.pointerId) return;
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / zoom;
      const y = (event.clientY - rect.top) / zoom;
      state_.moved = true;
      setLinkDrag({ fromId: state_.fromId, x, y });
    },
    [zoom],
  );

  const onLinkDotPointerUp = React.useCallback(
    (event: React.PointerEvent<Element>) => {
      const state_ = linkDragRef.current;
      if (state_ === null || event.pointerId !== state_.pointerId) return;
      const moved = state_.moved;
      linkDragRef.current = null;
      setLinkDrag(null);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
      if (!moved) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const nodeEl = hit?.closest<HTMLElement>("[data-node-id]") ?? null;
      const targetId = nodeEl?.dataset.nodeId;
      if (targetId === undefined) {
        store.toast("松开在空白处，没有连上");
        return;
      }
      store.addFreeLink(state_.fromId, targetId);
    },
    [store],
  );

  /** 提交图片说明。 */
  const commitCaption = React.useCallback(() => {
    const editing = captionEdit;
    setCaptionEdit(null);
    if (editing === null || doc === null) return;
    const next = setImageCaption(doc.root, editing.nodeId, editing.imageId, editing.text);
    if (next !== undefined) store.mutate(next);
  }, [captionEdit, doc, store]);

  /** 提交编辑并（可选）继续加下一个兄弟。 */
  const commitEdit = React.useCallback(
    (options: { thenAddSibling?: boolean } = {}) => {
      if (doc === null || editingId === null) return;
      const nextRoot = setText(doc.root, editingId, draft);
      if (nextRoot === undefined) {
        store.edit(null);
        return;
      }
      const currentId = editingId;
      store.mutate(nextRoot);
      store.edit(null);

      if (options.thenAddSibling === true) {
        const added = insertSibling(nextRoot, currentId, "");
        if (added !== undefined) {
          store.mutate(added.root);
          store.select(added.id);
          store.edit(added.id);
        }
      } else {
        // 回车提交后停在原地，方便继续按方向键
        requestAnimationFrame(() => focusCanvas());
      }
    },
    [doc, editingId, draft, store, focusCanvas],
  );

  /** 结构动作统一入口：拿新树 + 新焦点。 */
  const applyTree = React.useCallback(
    (result: { root: MindNode; id?: string; focusId?: string } | undefined) => {
      if (result === undefined) return;
      store.mutate(result.root);
      const nextFocus = result.id ?? result.focusId;
      if (nextFocus !== undefined) store.select(nextFocus);
    },
    [store],
  );

  /** 有没有节点被手动摆过位置（决定「重新排版」按钮是否可用）。 */
  const hasManual = React.useMemo(() => {
    return doc === null ? false : hasManualPositions(doc.root);
  }, [doc]);

  /** 一键回到自动布局：清掉所有手动坐标。 */
  const resetLayout = React.useCallback(() => {
    if (doc === null) return;
    const next = clearAllPositions(doc.root);
    if (next === undefined) {
      store.toast("所有节点都已经是自动布局");
      return;
    }
    store.mutate(next);
    store.toast("已恢复自动布局");
  }, [doc, store]);

  /**
   * 把内容居中到视口里。
   *
   * 画布四周有 PAD 留白，用户可能把内容拖到视野之外找不回来，
   * 这个按钮是确定的退路。
   */
  const centerContent = React.useCallback(() => {
    const wrap = scrollRef.current;
    if (wrap === null || layout === null) return;
    const rect = wrap.getBoundingClientRect();
    /*
     * 居中到**根节点**而不是整张布局的包围盒中心。
     *
     * 布局可能很宽（十几个分支），包围盒中心常常落在两片内容之间的空白处，
     * 用户点完还是什么都看不见。根节点是内容的起点，对准它才有意义。
     */
    const anchor =
      layout.nodes.find((node) => node.depth === 0) ??
      layout.nodes[0];
    if (anchor === undefined) return;
    const cx = (PAD + anchor.x + anchor.width / 2) * zoom;
    const cy = (PAD + anchor.y + anchor.height / 2) * zoom;
    wrap.scrollLeft = cx - rect.width / 2;
    wrap.scrollTop = cy - rect.height / 2;
  }, [layout, zoom]);

  /** 加子节点（Tab / 按钮）。 */
  const addChild = React.useCallback(() => {
    if (doc === null || selectedId === null) return;
    const result = insertChild(doc.root, selectedId, "");
    if (result === undefined) {
      store.toast("节点数量已达上限", "error");
      return;
    }
    applyTree(result);
    store.edit(result.id);
  }, [doc, selectedId, store, applyTree]);

  /** 加同级节点（Enter / 按钮）。 */
  const addSibling = React.useCallback(() => {
    const anchor = selectedId ?? doc?.root.id;
    if (doc === null || anchor === undefined) return;
    const result = insertSibling(doc.root, anchor, "");
    if (result === undefined) {
      store.toast("节点数量已达上限", "error");
      return;
    }
    applyTree(result);
    store.edit(result.id);
  }, [doc, selectedId, store, applyTree]);

  /** 删除选中节点。 */
  const deleteSelected = React.useCallback(() => {
    if (doc === null || selectedId === null) return;
    if (doc.root.id === selectedId) {
      store.toast("中心主题不能删除", "error");
      return;
    }
    const result = removeNode(doc.root, selectedId);
    if (result === undefined) return;
    store.mutate(result.root);
    store.select(result.focusId);
    requestAnimationFrame(() => focusCanvas());
  }, [doc, selectedId, store, focusCanvas]);

  /** 画布级键盘处理。 */
  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (doc === null) return;
      // 编辑态由 input 自己处理（见 NodeEditor），这里只接画布态
      if (editingId !== null) return;

      const target = event.target as HTMLElement;
      // 让输入框（标题栏等）里的按键不被画布截走
      if (target !== event.currentTarget && target.tagName === "INPUT") return;

      // Cmd/Ctrl + F：打开搜索并聚焦输入框
      if ((event.metaKey || event.ctrlKey) && (event.key === "f" || event.key === "F")) {
        event.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLInputElement>("[data-mm-search-input]");
          input?.focus();
          input?.select();
        });
        return;
      }

      /*
       * 缩放快捷键：Cmd/Ctrl + = / − / 0。
       *
       * 必须放在 Enter / Tab 那些分支**之前**处理并 return，否则
       * Cmd+0 之类会先被后面的逻辑吞掉。这里只认带 Cmd/Ctrl 的组合，
       * 单独按 = 或 − 不缩放（那是用户可能在输入别的）。
       */
      if ((event.metaKey || event.ctrlKey) && (event.key === "=" || event.key === "+" || event.key === "-")) {
        event.preventDefault();
        zoomStep(event.key === "-" ? -1 : 1);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "0") {
        event.preventDefault();
        applyZoom(1);
        return;
      }

      /*
       * 选中节点后直接打字 = 进入编辑（用户需求，v0.8.0）。
       *
       * 判定条件刻意收得很紧，避免抢掉快捷键：
       *   - 长度为 1 的可打印字符（排除 Tab / Enter / 方向键 / Delete 等）；
       *   - 不带 Cmd/Ctrl/Alt（那些是撤销、缩放、缩进等组合键）；
       *   - 不在输入法合成中（中文打字时 key 是 "Process" 或 isComposing 为真，
       *     这时候抢键会把输入法拆散）。
       *
       * 首字符会顶替原文字（见 pendingCharRef），符合"直接改写"的直觉。
       */
      if (
        selectedId !== null &&
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.isComposing
      ) {
        event.preventDefault();
        pendingCharRef.current = event.key;
        store.edit(selectedId);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        addSibling();
        return;
      }
      /*
       * Tab / Shift+Tab 的键位定案（2026-11-05 用户反馈后修正）。
       *
       * 早先 Tab = 缩进、Shift+Tab = 取消缩进，直接把大纲编辑器（幕布 /
       * Workflowly）的习惯搬了过来。但对思维导图用户来说「Tab 加子节点」
       * 才是直觉——而且那次搬运时，真正加子节点的 addChild() 根本没绑到
       * 任何按键或按钮上，"加子节点"这个能力实际是不可达的。
       *
       * 现在的分工，同时满足两种肌肉记忆：
       *   Tab            → 加子节点（导图直觉）
       *   Shift+Tab      → 减一级缩进（大纲直觉保留）
       *   Alt+→ / Alt+←  → 增加 / 减少缩进（要调层级时用这对）
       *   Enter          → 加同级
       */
      if (event.key === "Tab") {
        event.preventDefault();
        if (event.shiftKey) {
          if (selectedId !== null) {
            const next = outdentNode(doc.root, selectedId);
            if (next === undefined) store.toast("已经是第一层，不能再往外移");
            else applyTree({ root: next, focusId: selectedId });
          }
        } else {
          addChild();
        }
        return;
      }
      // Alt+→ 缩进（成为前一个兄弟的子节点），Alt+← 取消缩进
      if (event.altKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
        event.preventDefault();
        if (selectedId === null) return;
        if (event.key === "ArrowRight") {
          const next = indentNode(doc.root, selectedId);
          if (next === undefined) store.toast("第一个兄弟不能再缩进");
          else applyTree({ root: next, focusId: selectedId });
        } else {
          const next = outdentNode(doc.root, selectedId);
          if (next === undefined) store.toast("已经是第一层，不能再往外移");
          else applyTree({ root: next, focusId: selectedId });
        }
        return;
      }
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        if (selectedId !== null) {
          const next = moveSibling(doc.root, selectedId, event.key === "ArrowUp" ? -1 : 1);
          if (next !== undefined) applyTree({ root: next, focusId: selectedId });
        }
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (event.key === " " || event.key === "F2") {
        event.preventDefault();
        if (selectedId !== null) store.edit(selectedId);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        store.selectEdge(null);
        store.selectFreeLink(null);
        store.select(null);
        return;
      }
      /*
       * 撤销 / 重做。
       *
       * 放在画布的 keydown 里而不是全局监听：用户可能同时在会话输入框里打字，
       * 全局拦截会把宿主的 Ctrl+Z 吃掉。只有画布有焦点时才生效。
       *
       * 重做同时支持 Ctrl+Shift+Z（macOS 与多数编辑器）和 Ctrl+Y（Windows 习惯）。
       */
      if ((event.metaKey || event.ctrlKey) && (event.key === "z" || event.key === "Z")) {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === "y" || event.key === "Y")) {
        event.preventDefault();
        store.redo();
        return;
      }
      /*
       * Cmd/Ctrl + D 复制节点（连同子树）。
       *
       * 必须拦掉浏览器默认行为：Cmd+D 是"加入书签"，不拦会弹收藏对话框。
       * 与其它快捷键一样只在画布有焦点时生效。
       */
      if ((event.metaKey || event.ctrlKey) && (event.key === "d" || event.key === "D")) {
        event.preventDefault();
        store.duplicate();
        return;
      }
      if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        if (selectedId === null) {
          store.select(doc.root.id);
          return;
        }
        const move = event.key.slice(5).toLowerCase() as Move;
        const next = nextSelection(doc.root, selectedId, move);
        if (next !== undefined) focusNode(next);
        return;
      }
    },
    [doc, editingId, selectedId, addSibling, deleteSelected, store, applyTree, focusNode, focusCanvas, zoomStep, applyZoom],
  );

  if (doc === null || layout === null) {
    return <div className="mm-empty">没有打开任何导图。</div>;
  }

  return (
    <>
      {/*
       * 节点操作条。
       *
       * 为什么必须有：这些动作用键盘都能做（Tab / Enter），但新用户不会读
       * 提示条，鼠标用户也没有发现路径。上一版 addChild 写好了却没有任何
       * 入口，"加子节点"等于不存在——这是用户实际踩到的坑。
       *
       * 位置：放在滚动区**外面**、工具栏正下方。放进滚动区试过 sticky，
       * 但父级是 overflow:auto 的滚动容器时 sticky 的 top/bottom 表现不可靠，
       * 而且左上角会被根节点压住。
       */}
      <div className="mm-actions" role="toolbar" aria-label="节点操作">
        {/*
         * 这里**故意只留隐藏的 file input**，不放"+ 子节点 / + 主题 / + 同级 /
         * + 图片 / − 图片 / 复制节点"这些按钮（用户要求 v0.15.1）。
         *
         * 这些动作都已经有更顺手的入口：
         *   Tab 加子节点、Enter 加同级、双击空白加主题、
         *   粘贴/拖入加图片、Cmd/Ctrl+D 复制、图片上悬停删除。
         * 工具条上再摆一遍只会把画布压窄、还要花精力判断"该点哪个"。
         */}
        <input
          ref={replaceInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          style={{ display: "none" }}
          onChange={onReplacePicked}
          aria-hidden="true"
          tabIndex={-1}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          style={{ display: "none" }}
          onChange={onFilesPicked}
          aria-hidden="true"
          tabIndex={-1}
        />
        <div className="mm-grow" />
        {/*
         * 搜索：按正文快速定位节点。
         * Cmd/Ctrl+F 打开，Enter / Shift+Enter 在匹配之间跳。
         */}
        {searchOpen ? (
          <div className="mm-search" data-mm-search="true">
            <input
              className="mm-search-input"
              data-mm-search-input="true"
              value={searchQuery}
              autoFocus
              aria-label="搜索节点"
              placeholder="搜索节点内容（Enter 下一个，Esc 关闭）"
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  gotoMatch(matchIndex + (event.shiftKey ? -1 : 1));
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setSearchOpen(false);
                  setSearchQuery("");
                  focusCanvas();
                }
              }}
            />
            <span className="mm-search-count" data-mm-search-count="true">
              {matchIds.length === 0
                ? searchQuery.trim().length === 0
                  ? ""
                  : "无匹配"
                : String(matchIndex + 1) + "/" + String(matchIds.length)}
            </span>
            <button
              type="button"
              className="mm-btn"
              data-icon="true"
              data-mm-action="search-close"
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery("");
                focusCanvas();
              }}
              title="关闭搜索"
            >
              ×
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="mm-btn"
            data-mm-action="search"
            onClick={() => {
              setSearchOpen(true);
              requestAnimationFrame(() => {
                document.querySelector<HTMLInputElement>("[data-mm-search-input]")?.focus();
              });
            }}
            title="搜索节点内容（Cmd/Ctrl+F）"
          >
            搜索
          </button>
        )}
        {/*
         * 撤销 / 重做。
         *
         * 用 canUndo/canRedo 控制禁用态：按钮灰着比点了没反应好——用户能
         * 一眼看出"到头了"，而不是怀疑功能坏了。
         */}
        <button
          type="button"
          className="mm-btn"
          data-mm-action="undo"
          onClick={() => store.undo()}
          disabled={!state.historyState.canUndo}
          title="撤销（Cmd/Ctrl+Z）"
        >
          ↶ 撤销
        </button>
        <button
          type="button"
          className="mm-btn"
          data-mm-action="redo"
          onClick={() => store.redo()}
          disabled={!state.historyState.canRedo}
          title="重做（Cmd/Ctrl+Shift+Z）"
        >
          ↷ 重做
        </button>
        {/* 拖动会把位置写死；这里给一条一键回到自动布局的退路 */}
        <button
          type="button"
          className="mm-btn"
          data-mm-action="auto-layout"
          onClick={resetLayout}
          disabled={!hasManual}
          title={hasManual ? "把所有手动摆放的节点恢复成自动布局" : "所有节点都还是自动布局"}
        >
          重新排版
        </button>

        {/*
         * 缩放控件。
         *
         * 放在操作条最右边而不是画布角上：画布右下角被宿主的桌面宠物
         * 浮层占着（之前属性面板的按钮就被它盖住过），放那儿会点不到。
         */}
        <div className="mm-zoom" role="group" aria-label="画布缩放">
          <button
            type="button"
            className="mm-btn mm-zoom-btn"
            data-mm-action="zoom-out"
            onClick={() => zoomStep(-1)}
            disabled={zoom <= ZOOM_MIN + 1e-6}
            title="缩小（Cmd/Ctrl+−）"
            aria-label="缩小"
          >
            −
          </button>
          <button
            type="button"
            className="mm-zoom-value"
            data-mm-action="zoom-reset"
            onClick={() => applyZoom(1)}
            title="点击恢复 100%"
            aria-label={"当前缩放 " + String(Math.round(zoom * 100)) + "%，点击恢复 100%"}
          >
            {String(Math.round(zoom * 100))}%
          </button>
          {/*
           * 居中：无限画布没有滚动条，内容被拖到视野外时需要一个确定的退路。
           * 放在缩放旁边，因为它和"我现在看到哪儿"是同一类操作。
           */}
          <button
            type="button"
            className="mm-btn"
            data-mm-action="center"
            onClick={centerContent}
            title="把内容挪回视野中央"
          >
            居中
          </button>
          <button
            type="button"
            className="mm-btn mm-zoom-btn"
            data-mm-action="zoom-in"
            onClick={() => zoomStep(1)}
            disabled={zoom >= ZOOM_MAX - 1e-6}
            title="放大（Cmd/Ctrl++）"
            aria-label="放大"
          >
            +
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="mm-canvas-wrap"
        data-mm-canvas-wrap="true"
        data-drop-active={dragOver ? "true" : undefined}
        data-panning={panning ? "true" : undefined}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onScroll={() => tooltip.hide()}
        onDoubleClick={onCanvasDoubleClick}
        onClick={onWrapClick}
        onPointerDown={onWrapPointerDown}
        onPointerMove={onWrapPointerMove}
        onPointerUp={onWrapPointerUp}
        onMouseDown={onWrapMouseDown}
        onAuxClick={onWrapAuxClick}
        onContextMenu={onWrapContextMenu}
      >
        {/*
         * 画布本体。
         *
         * 平移和缩放都走 transform（translate + scale），不依赖滚动容器：
         * 滚动范围会被内容尺寸卡死，而 transform 没有边界——这就是无限画布。
         */}
        {/* 撑出滚动范围的虚拟留白：内容 + 四周 PAD */}
        <div
          className="mm-canvas-space"
          style={{ width: (layout.width + PAD * 2) * zoom, height: (layout.height + PAD * 2) * zoom }}
          aria-hidden="true"
        />
        <div
          ref={canvasRef}
        className="mm-canvas"
        tabIndex={0}
        role="tree"
        aria-label="思维导图画布"
        onKeyDown={onKeyDown}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={(event) => {
          onCanvasPointerMove(event);
          onPointerMove(event);
        }}
        onPointerUp={(event) => {
          onCanvasPointerUp(event);
          onPointerUp(event);
        }}
        onPointerCancel={onPointerCancel}
        style={{
          width: layout.width,
          height: layout.height,
          left: PAD * zoom,
          top: PAD * zoom,
          transform: "scale(" + String(zoom) + ")",
        }}
      >
        <svg
          className="mm-links"
          width={layout.width}
          height={layout.height}
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
          aria-hidden="true"
        >
          {layout.links.map((link) => {
            /*
             * 拖动预览期间连线必须跟着走。
             *
             * 节点位置在拖动中用 dragPreview 实时渲染，但 layout 还是松手前的
             * 那一版；如果连线直接用 layout 的坐标，就会出现"节点已经移开、
             * 线还连着原位置"的错位。这里按预览坐标重算端点。
             */
            const moving = dragPreview !== null ? new Set(dragIds) : null;
            const previewFrom = moving?.has(link.fromId) === true ? dragPreview : null;
            const previewTo = moving?.has(link.toId) === true ? dragPreview : null;
            const fromNode = layout.nodes.find((n) => n.id === link.fromId);
            const toNode = layout.nodes.find((n) => n.id === link.toId);
            if ((previewFrom !== null || previewTo !== null) && fromNode && toNode) {
              const x1 = previewFrom !== null ? fromNode.x + previewFrom.dx + fromNode.width : link.x1;
              const y1 = previewFrom !== null ? fromNode.y + previewFrom.dy + fromNode.height / 2 : link.y1;
              const x2 = previewTo !== null ? toNode.x + previewTo.dx : link.x2;
              const y2 = previewTo !== null ? toNode.y + previewTo.dy + toNode.height / 2 : link.y2;
              return (
                <path
                  key={link.fromId + ">" + link.toId}
                  className="mm-link"
                  d={linkPath({ ...link, x1, y1, x2, y2 })}
                />
              );
            }
            const d = linkPath(link);
            const key = link.fromId + ">" + link.toId;
            return (
              <g key={key}>
                <path
                  className="mm-link"
                  data-active={pathIds.has(link.fromId) && pathIds.has(link.toId) ? "true" : undefined}
                  data-selected={state.selectedEdgeId === link.toId ? "true" : undefined}
                  data-style={link.style ?? doc.linkStyle ?? "solid"}
                  d={d}
                />
                {/*
                 * 透明加粗命中区：线本身只有 1.5px，直接点几乎点不中。
                 * 放在线的下层（先渲染），不影响视觉。
                 */}
                <path
                  className="mm-link-hit"
                  d={d}
                  data-mm-link-to={link.toId}
                  onPointerDown={(event) => onLinkPointerDown(event, link)}
                  onPointerMove={onLinkPointerMove}
                  onPointerUp={onLinkPointerUp}
                  onPointerCancel={onLinkPointerUp}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    setEdgeDraft(link.label ?? "");
                    setEdgeEditId(link.toId);
                  }}
                />
              </g>
            );
          })}
          {/* 拖动连线时跟随鼠标的虚线：让用户看得见自己在把线拖向哪里 */}
          {relink !== null
            ? (() => {
                const from = layout.nodes.find((n) => n.id === relink.fromId);
                const child = layout.nodes.find((n) => n.id === relink.childId);
                /*
                 * 拖哪一端，就从**另一端**画到鼠标：
                 *   - 拖子端 -> 父端不动，虚线从父节点右边出发；
                 *   - 拖父端 -> 子端不动，虚线从子节点左边出发。
                 * 这样看起来就是"这一头被你拽着走"。
                 */
                const anchor =
                  relink.end === "child"
                    ? from === undefined
                      ? null
                      : { x: from.x + from.width, y: from.y + from.height / 2 }
                    : child === undefined
                      ? null
                      : { x: child.x, y: child.y + child.height / 2 };
                if (anchor === null) return null;
                return (
                  <path
                    className="mm-link-ghost"
                    d={
                      "M " +
                      String(anchor.x) +
                      " " +
                      String(anchor.y) +
                      " L " +
                      String(relink.x) +
                      " " +
                      String(relink.y)
                    }
                  />
                );
              })()
            : null}

          {/*
           * 选中节点的入边：两端各出一个可拖拽端点 + 中点一个删除按钮。
           *
           * 为什么要显式画手柄：连线本体只有 1.5px，靠"精确点在线上再拖"
           * 在密集的图里几乎做不到（用户反馈 v0.14.3）。手柄是 11px 的圆点，
           * 好点得多，而且"两端都能拖"这件事本身就变得可见。
           */}
          {selectedIncomingLink !== null
            ? (() => {
                const link = selectedIncomingLink;
                const midX = (link.x1 + link.x2) / 2;
                const midY = (link.y1 + link.y2) / 2;
                /*
                 * 手柄要往线的**内侧**挪一点。
                 *
                 * 端点正好落在父节点右边缘 / 子节点左边缘上，节点是绝对定位的
                 * div，在 DOM 里排在 svg 之后，会把圆点盖住——按下事件到不了它，
                 * 表现就是"手柄看得见但拖不动"。挪 10px 就落在两节点之间的空档里。
                 * 曲线两端切线是水平的，所以 y 基本不用动。
                 */
                const HANDLE_INSET = 10;
                return (
                  <g className="mm-edge-tools">
                    {/*
                     * 线型切换：只有选中这条线时才出现。
                     * 选中节点时不该出现任何"改线"的入口（线是独立对象）。
                     */}
                    <g
                      className="mm-edge-style"
                      transform={
                        "translate(" +
                        String(midX + 44) +
                        ", " +
                        String(midY - 18) +
                        ")"
                      }
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <rect
                        className="mm-edge-style-bg"
                        x={0}
                        y={0}
                        width={86}
                        height={20}
                        rx={10}
                      />
                      <text
                        className="mm-edge-style-opt"
                        data-active={(link.style ?? doc.linkStyle ?? "solid") === "solid" ? "true" : undefined}
                        x={22}
                        y={14}
                        onClick={() => store.setEdgeStyle(link.toId, "solid")}
                      >
                        实线
                      </text>
                      <text
                        className="mm-edge-style-opt"
                        data-active={(link.style ?? doc.linkStyle ?? "solid") === "dashed" ? "true" : undefined}
                        x={64}
                        y={14}
                        onClick={() => store.setEdgeStyle(link.toId, "dashed")}
                      >
                        虚线
                      </text>
                    </g>
                    <circle
                      className="mm-edge-handle"
                      cx={link.x1 + HANDLE_INSET}
                      cy={link.y1}
                      r={5}
                      data-mm-edge-handle={link.toId}
                      data-mm-end="parent"
                      onPointerDown={(event) => beginRelink(event, link, "parent")}
                      onPointerMove={onLinkPointerMove}
                      onPointerUp={onLinkPointerUp}
                      onPointerCancel={onLinkPointerUp}
                    >
                      <title>拖动这一端：把节点改挂到别的节点下</title>
                    </circle>
                    <circle
                      className="mm-edge-handle"
                      cx={link.x2 - HANDLE_INSET}
                      cy={link.y2}
                      r={5}
                      data-mm-edge-handle={link.toId}
                      data-mm-end="child"
                      onPointerDown={(event) => beginRelink(event, link, "child")}
                      onPointerMove={onLinkPointerMove}
                      onPointerUp={onLinkPointerUp}
                      onPointerCancel={onLinkPointerUp}
                    >
                      <title>拖动这一端：把节点改挂到别的节点下</title>
                    </circle>
                    <g
                      className="mm-edge-remove"
                      data-mm-edge-remove={link.toId}
                      /*
                       * 上移 18px：文字编辑框就落在中点上，按钮不挪开会被输入框盖住，
                       * 表现为"点得到选中、却点不到删除"。
                       */
                      transform={"translate(" + String(midX) + "," + String(midY - 18) + ")"}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        removeIncomingEdge(link.toId);
                      }}
                    >
                      <title>删除这条连线（节点会变成自由主题，内容不丢）</title>
                      <circle r={8} />
                      <path d="M -3 -3 L 3 3 M 3 -3 L -3 3" />
                    </g>
                  </g>
                );
              })()
            : null}
          {/*
           * 自由连线：虚线，不改变树结构。
           *
           * 和父子连线用不同的线型（虚线）区分：实线是"层级关系"，
           * 虚线是"我另外标的关联"。一个节点可以有任意多条自由连线。
           */}
          {freeLinks.map(({ link, d, x1, y1, x2, y2, midX, midY }) => (
            <g key={"free-" + link.id}>
              <path
                className="mm-link mm-free-link"
                data-selected={state.selectedFreeLinkId === link.id ? "true" : undefined}
                data-style={link.style ?? doc.linkStyle ?? "solid"}
                d={d}
              />
              <path
                className="mm-link-hit"
                d={d}
                data-mm-free-link={link.id}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  store.selectFreeLink(link.id);
                  setEdgeDraft(link.label ?? "");
                  setEdgeEditId(null);
                  setFreeLinkEditId(link.id);
                }}
              />
              {link.label !== undefined && link.label.length > 0 && freeLinkEditId !== link.id ? (
                <text className="mm-free-link-label" x={midX} y={midY - 6} textAnchor="middle">
                  {link.label}
                </text>
              ) : null}
              {/*
               * 自由连线的线型切换：选中这条线时出现，和父子连线保持同一套操作。
               */}
              {state.selectedFreeLinkId === link.id ? (
                <g
                  className="mm-edge-style"
                  transform={"translate(" + String(midX + 44) + ", " + String(midY - 18) + ")"}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <rect className="mm-edge-style-bg" x={0} y={0} width={86} height={20} rx={10} />
                  <text
                    className="mm-edge-style-opt"
                    data-active={(link.style ?? doc.linkStyle ?? "solid") === "solid" ? "true" : undefined}
                    x={22}
                    y={14}
                    onClick={() => store.setFreeLinkStyle(link.id, "solid")}
                  >
                    实线
                  </text>
                  <text
                    className="mm-edge-style-opt"
                    data-active={(link.style ?? doc.linkStyle ?? "solid") === "dashed" ? "true" : undefined}
                    x={64}
                    y={14}
                    onClick={() => store.setFreeLinkStyle(link.id, "dashed")}
                  >
                    虚线
                  </text>
                </g>
              ) : null}
              {state.selectedFreeLinkId === link.id ? (
                <g
                  className="mm-edge-remove"
                  data-mm-free-link-remove={link.id}
                  transform={"translate(" + String(midX) + "," + String(midY - 18) + ")"}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    store.removeFreeLink(link.id);
                    store.selectFreeLink(null);
                  }}
                >
                  <title>删除这条关系线</title>
                  <circle r={8} />
                  <path d="M -3 -3 L 3 3 M 3 -3 L -3 3" />
                </g>
              ) : null}
            </g>
          ))}

          {/* 从节点拉出新连线时跟随鼠标的虚线 */}
          {linkDrag !== null
            ? (() => {
                const from = layout.nodes.find((n) => n.id === linkDrag.fromId);
                if (from === undefined) return null;
                return (
                  <path
                    className="mm-link-ghost"
                    d={
                      "M " +
                      String(from.x + from.width / 2) +
                      " " +
                      String(from.y + from.height) +
                      " L " +
                      String(linkDrag.x) +
                      " " +
                      String(linkDrag.y)
                    }
                  />
                );
              })()
            : null}

          {/*
           * 选中节点**右边缘中点**的"拉线"小圆点：拖到另一个节点就建一条自由连线。
           *
           * 放在右侧而不是底部：连接点统一在方框的左右两端，
           * 底部出现圆点会让"这里能拖"和"这里能连线"两种暗示混在一起。
           */}
          {selectedNode !== null ? (
            <circle
              className="mm-link-dot"
              cx={selectedNode.x + selectedNode.width}
              cy={selectedNode.y + selectedNode.height / 2}
              r={6}
              data-mm-link-dot={selectedNode.id}
              onPointerDown={(event) => onLinkDotPointerDown(event, selectedNode.id)}
              onPointerMove={onLinkDotPointerMove}
              onPointerUp={onLinkDotPointerUp}
              onPointerCancel={onLinkDotPointerUp}
            >
              <title>拖到另一个节点，拉出一条关系线</title>
            </circle>
          ) : null}
        </svg>

        {/* 连线文字编辑框 */}
        {edgeEditId !== null
          ? (() => {
              const link = layout.links.find((l) => l.toId === edgeEditId);
              if (link === undefined) return null;
              return (
                <input
                  className="mm-edge-input"
                  style={{ left: link.labelX, top: link.labelY }}
                  value={edgeDraft}
                  autoFocus
                  aria-label="连线文字"
                  placeholder="连线说明（回车确认，Esc 取消）"
                  onChange={(event) => setEdgeDraft(event.target.value)}
                  onBlur={() => commitEdgeLabel()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitEdgeLabel();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setEdgeEditId(null);
                    }
                  }}
                />
              );
            })()
          : null}

        {/* 自由连线的文字编辑框 */}
        {freeLinkEditId !== null
          ? (() => {
              const geo = freeLinks.find((item) => item.link.id === freeLinkEditId);
              if (geo === undefined) return null;
              return (
                <input
                  className="mm-edge-input"
                  style={{ left: geo.midX, top: geo.midY }}
                  value={edgeDraft}
                  autoFocus
                  aria-label="关系线文字"
                  placeholder="这条关系是什么（回车确认，Esc 取消）"
                  onChange={(event) => setEdgeDraft(event.target.value)}
                  onBlur={() => {
                    const id = freeLinkEditId;
                    setFreeLinkEditId(null);
                    if (id !== null) store.setFreeLinkLabel(id, edgeDraft);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const id = freeLinkEditId;
                      setFreeLinkEditId(null);
                      if (id !== null) store.setFreeLinkLabel(id, edgeDraft);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setFreeLinkEditId(null);
                    }
                  }}
                />
              );
            })()
          : null}

        {/* 框选虚线框：画在节点下层，避免遮住节点文字 */}
        {marquee !== null ? (
          <div
            className="mm-marquee"
            data-mm-marquee="true"
            style={{
              left: marquee.x,
              top: marquee.y,
              width: marquee.w,
              height: marquee.h,
            }}
          />
        ) : null}

        {/* 图片说明编辑框：贴在所属节点下方 */}
        {captionEdit !== null
          ? (() => {
              const node = layout.nodes.find((n) => n.id === captionEdit.nodeId);
              if (node === undefined) return null;
              return (
                <input
                  className="mm-edge-input mm-caption-input"
                  style={{ left: node.x + node.width / 2, top: node.y + node.height + 16 }}
                  value={captionEdit.text}
                  autoFocus
                  aria-label="图片说明"
                  placeholder="图片说明（回车确认，Esc 取消）"
                  onChange={(event) =>
                    setCaptionEdit((current) =>
                      current === null ? null : { ...current, text: event.target.value },
                    )
                  }
                  onBlur={() => commitCaption()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitCaption();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setCaptionEdit(null);
                    }
                  }}
                />
              );
            })()
          : null}

        {layout.nodes.map((node) => {
          const isEditing = editingId === node.id;
          // 拖动中的节点用实时坐标渲染：松手才写回文档，避免每帧改数据
          const preview =
            dragPreview !== null && dragIds.includes(node.id) ? dragPreview : null;
          const nodeX = preview !== null ? node.x + preview.dx : node.x;
          const nodeY = preview !== null ? node.y + preview.dy : node.y;
          const isSelected = selectedIds.includes(node.id);
          const nodeStyle = styleToCss(findNode(doc.root, node.id));
          return (
            <div
              key={node.id}
              data-node-id={node.id}
              className="mm-node"
              role="treeitem"
              aria-selected={isSelected}
              aria-expanded={node.hasChildren ? !node.collapsed : undefined}
              data-root={node.depth === 0 ? "true" : undefined}
              data-depth={node.depth <= 2 ? node.depth : undefined}
              data-selected={isSelected ? "true" : undefined}
              data-on-path={pathIds.has(node.id) ? "true" : undefined}
              data-collapsed={node.collapsed ? "true" : undefined}
              data-editing={isEditing ? "true" : undefined}
              title={node.title}
              data-manual={node.manual ? "true" : undefined}
              data-dragging={preview !== null ? "true" : undefined}
              data-multi={selectedIds.length > 1 && isSelected ? "true" : undefined}
              data-styled={nodeStyle !== undefined ? "true" : undefined}
              data-match={matchIds.includes(node.id) ? "true" : undefined}
              data-match-current={
                matchIds.length > 0 && matchIds[matchIndex] === node.id ? "true" : undefined
              }
              style={{
                left: nodeX,
                top: nodeY,
                /*
                 * 编辑态不锁尺寸：方框跟着编辑框一起长（内联宽高在这里省掉）。
                 *
                 * 定位保持左上角不动、向右下展开。试过"以中心为基准对称展开"，
                 * 更居中好看，但节点靠近画布左上边缘时会有一半被裁到画布外
                 * （root 的 x 只有 32，放大到 206 宽就变成 -25）。
                 * 保持左上角则永远不会裁到自己，代价只是视觉上略微偏右。
                 */
                ...(isEditing ? {} : { width: node.width, height: node.height }),
                // 缩放时视觉与命中区一起缩，不需要额外校准
                ...nodeStyle,
              }}
              onPointerDown={(event) => onPointerDown(event, node.id)}
              onClick={(event) => {
                event.stopPropagation();
                /*
                 * 编辑态下点击必须**什么都不做**。
                 *
                 * 下面那句 focusCanvas() 会把焦点从输入框抢走，
                 * 输入框随即 blur -> commitEdit -> 退出编辑。
                 * 表现出来就是"想点一下把光标放到某个字后面，结果直接退出编辑了"
                 * （用户反馈 v0.13.2）。
                 * 编辑态的 pointerdown 早就有同样的保护，click 这里漏了。
                 */
                if (editingId === node.id) return;
                if (suppressClickRef.current) return;
                store.select(node.id);
                focusCanvas();
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                store.edit(node.id);
              }}
              onMouseEnter={(event) => tooltip.onEnter(event, node.text)}
              onMouseLeave={tooltip.onLeave}
            >
              {isEditing ? (
                /*
                 * 用 textarea 而不是 input（用户需求 v0.8.2）：
                 * 单行 input 在 34px 的方框里又矮又窄，长文字只能看到一小截，
                 * 编辑时完全没法通读。textarea 可以换行、可以自动增高，
                 * 编辑时整段内容都在视野里。
                 *
                 * rows=1 + 自动增高（见下面的 effect）：内容少时不会比节点高多少，
                 * 内容多时按实际行数长高。
                 */
                <textarea
                  ref={inputRef}
                  className="mm-node-input"
                  value={draft}
                  rows={1}
                  aria-label="节点文字"
                  /*
                   * 宽度按当前草稿的实测宽度来，夹在 180~360 之间。
                   *
                   * 固定宽度会两头不讨好：太窄时短文本编辑框比方框宽一大截
                   * （"小方框套大输入框"），太宽时长文本又被挤成竖条。
                   * 按内容算宽度，方框和输入框才始终贴合。
                   */
                  style={{ width: editorWidth }}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => commitEdit()}
                  onKeyDown={(event) => {
                    // 编辑态自己接管按键：不能让它们冒泡到画布，
                    // 否则打字时的 Backspace 会变成"删除整个节点"
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      /*
                       * 编辑态回车 = **只确认内容**，不新增节点（用户需求 v0.8.2）。
                       *
                       * 早先是"确认 + 顺手加一个同级节点"（大纲编辑器的连续录入流）。
                       * 但在导图里改一段文字时，回车往往只是"我改完了"，
                       * 却平白多出一个空节点，还要再删掉。
                       *
                       * 现在想加同级：回车确认后，画布态再按一次回车即可
                       * （键位没变，只是拆成两步，不会误加）。
                       */
                      event.preventDefault();
                      commitEdit();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      store.edit(null);
                    } else if (event.key === "Tab") {
                      event.preventDefault();
                      commitEdit();
                    }
                  }}
                />
              ) : (
                <>
                  {/*
                   * 节点标识（⭐ 重点 等）：和文字并排显示在方框左侧。
                   * 宽度已经算进布局（见 contentSize 的 marksWidth），
                   * 所以不会挤压文字或溢出方框。
                   */}
                  {node.marks !== undefined && node.marks.length > 0 ? (
                    <span className="mm-marks" aria-hidden="true">
                      {node.marks.map((glyph, index) => (
                        <span className="mm-mark" key={glyph + String(index)}>
                          {glyph}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  {node.hasText ? (
                    <span>{node.text}</span>
                  ) : node.images === undefined || node.images.length === 0 ? (
                    <span>空节点</span>
                  ) : null}
                  {node.images !== undefined && node.images.length > 0 ? (
                    <NodePictures
                      images={node.images}
                      onActivate={() => store.select(node.id)}
                      onOpen={(image) => setLightbox(image)}
                      onRemove={(imageId) => removeImage(node.id, imageId)}
                      onReplace={(imageId) => startReplaceImage(node.id, imageId)}
                      onCaption={(imageId, current) =>
                        setCaptionEdit({ nodeId: node.id, imageId, text: current })
                      }
                    />
                  ) : null}
                </>
              )}
              {node.hasChildren ? (
                <button
                  type="button"
                  className="mm-fold"
                  aria-label={node.collapsed ? "展开子节点" : "收起子节点"}
                  title={node.collapsed ? "展开子节点" : "收起子节点"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    const next = toggleCollapse(doc.root, node.id);
                    if (next !== undefined) store.mutate(next);
                  }}
                >
                  {node.collapsed ? "+" : "−"}
                </button>
              ) : null}
            </div>
          );
          })}

        {/* 连线文字：用 HTML 而不是 SVG text，方便选中态与双击编辑 */}
        {layout.links.map((link) =>
          link.label !== undefined && link.label.length > 0 && edgeEditId !== link.toId ? (
            <div
              key={"lbl-" + link.toId}
              className="mm-edge-label"
              data-mm-edge-label={link.toId}
              style={{ left: link.labelX, top: link.labelY }}
              title="双击修改连线文字"
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEdgeDraft(link.label ?? "");
                setEdgeEditId(link.toId);
              }}
            >
              {link.label}
            </div>
          ) : null,
        )}
        </div>
      </div>
      <NodeTooltip state={tooltip.state} />
      {lightbox !== null ? <Lightbox image={lightbox} onClose={() => setLightbox(null)} /> : null}
    </>
  );
}

/** 画布上方的工具栏。 */
export function CanvasToolbar({ store, state }: CanvasProps): React.ReactElement {
  const doc = state.doc;
  const [draftTitle, setDraftTitle] = React.useState("");
  const [editingTitle, setEditingTitle] = React.useState(false);

  React.useEffect(() => {
    if (!editingTitle) setDraftTitle(doc?.title ?? "");
  }, [doc?.title, doc?.id, editingTitle]);

  const nodeCount = doc === null ? 0 : countNodes(doc.root);
  const depth = doc === null ? 0 : maxDepth(doc.root);

  return (
    <div className="mm-bar">
      <button type="button" className="mm-btn" data-ghost="true" onClick={() => store.back()} title="返回导图列表">
        ← 返回
      </button>

      {editingTitle ? (
        <input
          className="mm-title-input"
          value={draftTitle}
          aria-label="导图标题"
          autoFocus
          onChange={(event) => setDraftTitle(event.target.value)}
          onBlur={() => {
            setEditingTitle(false);
            const value = draftTitle.trim();
            if (value.length > 0 && value !== doc?.title) {
              store.retitle(value);
              store.toast("标题已更新");
            } else {
              setDraftTitle(doc?.title ?? "");
            }
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            if (event.key === "Escape") {
              setDraftTitle(doc?.title ?? "");
              setEditingTitle(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="mm-btn"
          data-ghost="true"
          onClick={() => setEditingTitle(true)}
          title="点击改名"
          style={{ fontWeight: 600, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {doc?.title ?? "未命名导图"}
          <span style={{ color: "var(--dsw-alias-label-tertiary)", fontWeight: 400, marginLeft: 6 }}>
            {String(nodeCount)} 节点 · {String(depth)} 层
          </span>
        </button>
      )}

      <div className="mm-grow" />

      {/* Markdown 现在是右侧可开关的一栏，不再是与画布互斥的视图 */}
      <button
        type="button"
        className="mm-btn"
        data-primary={state.mdOpen ? "true" : undefined}
        onClick={() => store.showMarkdown()}
        data-mm-action="markdown"
        title={state.mdOpen ? "收起右侧 Markdown 栏" : "展开右侧 Markdown 栏（可直接编辑）"}
      >
        {state.mdOpen ? "收起 Markdown" : "Markdown"}
      </button>
      {/*
       * 保存状态。
       *
       * 自动保存最大的问题是"用户不知道存没存"，所以状态要一直可见，
       * 而不是只在出错时才出现。失败时点一下可以手动重试。
       */}
      <button
        type="button"
        className="mm-save-state"
        data-state={state.saveState}
        data-mm-action="save"
        onClick={() => {
          if (state.saveState === "error") {
            void store.flush().then(() => store.toast("已重新保存"));
            return;
          }
          void store.flush().then(() => store.toast("已保存到 DSH"));
        }}
        title={saveTitle(state)}
        aria-live="polite"
      >
        <span className="mm-save-dot" aria-hidden="true" />
        {saveLabel(state)}
      </button>
    </div>
  );
}

/** 键盘提示条。 */
export function KeyboardHints(): React.ReactElement {
  return (
    <div className="mm-hints" aria-hidden="true">
      <span><kbd>Tab</kbd> 加子节点</span>
      <span><kbd>Enter</kbd> 加同级</span>
      <span><kbd>Shift</kbd>+<kbd>Tab</kbd> 减一级</span>
      <span><kbd>Alt</kbd>+<kbd>←→</kbd> 缩进/取消</span>
      <span><kbd>Alt</kbd>+<kbd>↑↓</kbd> 上下移</span>
      <span><kbd>方向键</kbd> 切换节点</span>
      <span><kbd>Shift</kbd>+点击 多选</span>
      <span>空白处拖动 框选</span>
      <span>右键/中键拖动 平移</span>
      <span>双击空白 加主题</span>
      <span><kbd>Cmd/Ctrl</kbd>+<kbd>D</kbd> 复制</span>
      <span><kbd>空格</kbd> 改文字</span>
      <span><kbd>Del</kbd> 删除</span>
      <span><kbd>Cmd/Ctrl</kbd>+<kbd>Z</kbd> 撤销</span>
      <span>双击节点也能改</span>
    </div>
  );
}

/** 布局常量再导出：外层如果要做"适应窗口"会用到。 */
export { LAYOUT };

/* ------------------------------------------------------------------ *
 * 节点样式 → 内联 CSS
 * ------------------------------------------------------------------ */

/**
 * 在树里按 id 找节点。
 *
 * 画布的 layout 结果里只有几何信息，没有样式；样式要从树的节点上取。
 * 这里不缓存：一次渲染里每个节点查一次，树的规模有上限（5000），
 * 而更复杂的缓存失效逻辑反而容易出错。
 */
function findNode(node: MindNode, id: string): MindNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findNode(child, id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * 把节点样式翻成内联 CSS。
 *
 * 只返回**用户显式设置过**的属性：没设置就不写，交给 CSS 类与主题变量，
 * 这样"恢复默认"真的能回到主题外观，而不是被内联样式钉死。
 *
 * 配色用的是色板里的成对值（背景 + 前景），所以文字永远看得清。
 */
function styleToCss(node: MindNode | undefined): React.CSSProperties | undefined {
  const style = node?.style;
  if (style === undefined) return undefined;

  const css: Record<string, string | number> = {};

  const palette = paletteOf(style.color);
  if (palette !== undefined) {
    css.background = palette.background;
    css.color = palette.foreground;
  }
  if (style.fontSize !== undefined) css.fontSize = style.fontSize + "px";
  if (style.bold === true) css.fontWeight = 700;
  if (style.italic === true) css.fontStyle = "italic";
  if (style.radius !== undefined) css.borderRadius = style.radius + "px";
  if (style.borderWidth !== undefined) {
    css.borderWidth = style.borderWidth + "px";
    // 0 宽时 border-color 无所谓；非 0 时用当前文字色的低透明度版本，
    // 保证边框在自定义底色上也协调
    if (style.borderWidth > 0) css.borderStyle = "solid";
  }

  return Object.keys(css).length > 0 ? (css as React.CSSProperties) : undefined;
}

/* ------------------------------------------------------------------ *
 * 保存状态文案
 * ------------------------------------------------------------------ */

/** 保存状态的一句话说明（tooltip）。 */
function saveTitle(state: ViewState): string {
  switch (state.saveState) {
    case "pending":
      return "有改动等待写入（约 0.6 秒后自动保存）";
    case "saving":
      return "正在写入磁盘…";
    case "saved":
      return state.lastSavedAt !== null
        ? "已保存于 " + new Date(state.lastSavedAt).toLocaleTimeString()
        : "已保存";
    case "error":
      return "保存失败，点击重试（后台会自动重试）";
    default:
      return "自动保存已开启，点击立即保存";
  }
}

/** 保存状态的显示文案。 */
function saveLabel(state: ViewState): string {
  switch (state.saveState) {
    case "pending":
      return "未保存";
    case "saving":
      return "保存中…";
    case "saved":
      return "已保存";
    case "error":
      return "保存失败";
    default:
      return "保存";
  }
}
