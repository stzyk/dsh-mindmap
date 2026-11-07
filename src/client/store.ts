/**
 * dsh-mindmap — Host 通道与本地状态（Client 半区）。
 *
 * 数据流向刻意做成"Host 是唯一真相，浏览器只是缓存"：
 *   打开面板 → 拉 docs.list → 打开某份 → 拉 docs.get → 编辑时先在内存里改
 *   （立刻反馈，打字不能卡）→ 防抖 600ms 后 docs.save 回 Host。
 *
 * 为什么不在编辑时每敲一个字就 round-trip：
 *   中文输入法一个词要按好几次键，逐键提交会把 Host 写盘队列打满，
 *   而且光标位置会因为在等异步保存而抖。防抖 + 单一 flush 点是标准做法。
 *
 * 离线兜底：Host 通道不可用时把最近一次数据留在 localStorage，只作
 * **只读展示**——不做"本地优先同步"，那需要冲突合并，超出这个插件的范围。
 */

import type { MindDoc, MindDocSummary } from "../core/tree.ts";
import {
  applyStyle,
  applyStyleToSubtree,
  applyStyleToMany,
  clearStyle as clearNodeStyle,
  clearStyleMany,
} from "../core/style.ts";
import { MAX_MARKS, marksFull } from "../core/marks.ts";
import { addLink, removeLink, setLinkLabel } from "../core/tree.ts";
import {
  MAX_NODES,
  addTheme,
  cloneNode,
  countNodes,
  detachToTheme,
  disconnectNode,
  setNodeKind,
  sortSiblingsByPosition,
  setEdgeStyle,
  setLinkStyle,
  attachByLink,
  duplicateNodes,
  repointEdge,
  locate,
  moveNodes,
  pathTo,
  reparentNode,
  setEdgeLabel,
  toggleMark,
} from "../core/tree.ts";
import { createHistory, type History } from "./history.ts";
import { mergeTree } from "../core/parse.ts";

/** 通道前缀，必须与 src/index.ts 的 CHANNEL 一致。 */
export const CHANNEL = "/mindmap";

/** 插件 id：日志前缀与调试句柄名。 */
export const PLUGIN_ID = "dsh-mindmap";

/** 保存防抖（毫秒）。 */
const SAVE_DEBOUNCE = 600;
/**
 * 保存失败后的重试退避（毫秒）。
 *
 * 保存失败通常是宿主短暂不可用（重启中、网络抖动）。不重试的话
 * 用户的编辑就只停在内存里，直到下一次操作才再试一次——而"下一次操作"
 * 可能永远不会来（用户以为已经存好了）。
 * 退避到 30 秒封顶：既不会疯狂打宿主，也不会放弃太久。
 */
const SAVE_RETRY_DELAYS = [2000, 5000, 10000, 30000] as const;

/** 最近一次成功加载的列表缓存 key。 */
const CACHE_KEY = PLUGIN_ID + ":docs";

let rpcSeq = 0;

/** 通道错误：带 code，便于 UI 区分"没授权"和"真出错了"。 */
export class ChannelError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ChannelError";
  }
}

/**
 * 调用 Host 的一个 RPC 端点。
 * @param method - 端点名（docs.list 等）。
 * @param payload - 载荷。
 * @returns 端点的 value。
 * @throws {ChannelError} 网络 / 鉴权 / 业务错误统一收敛。
 */
export async function callHost<T = unknown>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  rpcSeq += 1;
  let response: Response;
  try {
    response = await fetch(CHANNEL + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: PLUGIN_ID + "-" + String(rpcSeq),
        method,
        payload,
      }),
    });
  } catch (error) {
    throw new ChannelError("network", "连不上 DSH： " + (error as Error).message);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ChannelError("unauthorized", "未授权（HTTP " + String(response.status) + "），请刷新页面后重试");
  }
  if (!response.ok) throw new ChannelError("http", "HTTP " + String(response.status));
  const body = (await response.json()) as {
    type?: string;
    result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
  };
  if (body?.type !== "server-response") throw new ChannelError("protocol", "无效的 RPC 响应");
  const result = body.result;
  if (result?.ok === true) return result.value as T;
  throw new ChannelError(result?.error?.code ?? "unknown", result?.error?.message ?? "操作失败");
}

/** 列表响应。 */
export interface ListPayload {
  docs: MindDocSummary[];
  file: string;
  maxDocs: number;
}

/** 文档响应。 */
interface DocPayload {
  doc: MindDoc;
  docs: MindDocSummary[];
}

/** 画布外的 UI 状态。 */
export interface ViewState {
  /** 当前视图。 */
  mode: "list" | "edit";
  /**
   * 右侧 Markdown 栏是否展开。
   *
   * 早先 Markdown 是一个与画布互斥的 mode：打开它就看不到画布。
   * 用户要的是"右边常驻、可隐藏、两边都能改"，所以拆成独立开关——
   * 画布始终在，Markdown 只是右侧的一栏。
   */
  mdOpen: boolean;
  /** 列表快照。 */
  docs: MindDocSummary[];
  /** 当前打开的文档。 */
  doc: MindDoc | null;
  /**
   * 主选中节点 id（"活动"节点）。
   *
   * 多选时它是其中最后点中的那个：原地编辑、键盘加子节点/同级、
   * 属性面板的标题显示都用它。要拿"全部选中"用 selectedIds。
   */
  selectedId: string | null;
  /**
   * 选中的**连线**（存它的子节点 id）。
   *
   * 连线在数据上仍是父子关系的推导结果，但在交互上要能像独立对象一样被选中：
   * 点一下线 = 选中这条边，然后才能编辑它的文字、删掉它、拖它的两端。
   * 没有这个状态的话，用户必须先找到子节点才能操作"那条线"。
   */
  selectedEdgeId: string | null;
  /** 选中的自由连线 id。 */
  selectedFreeLinkId: string | null;
  /**
   * 全部选中的节点 id（多选）。
   *
   * 单选时长度为 1 且等于 selectedId；框选或多选时会更长。
   * 为什么保留 selectedId 而不是只留这个数组：编辑、Tab 加子节点、
   * 缩进这些操作天然是"针对一个节点"的，用一个明确的锚点比每次
   * 取 ids[0] 更不容易出错。
   */
  selectedIds: string[];
  /** 正在原地编辑的节点 id。 */
  editingId: string | null;
  /** 搜索框内容（列表页）。 */
  query: string;
  /**
   * 右侧属性抽屉是否展开。
   *
   * 默认随选中自动展开（选中节点就是要调属性），用户点 × 可以收起；
   * 再次选中任何节点会重新展开——收起是"暂时不想看"，不是"永久关掉"。
   */
  styleOpen: boolean;
  /** 是否一开始就在加载。 */
  loading: boolean;
  /** 最近一条提示。 */
  toast: { text: string; tone: "info" | "error"; seq: number } | null;
  /** Host 通道是否可用（不可用时降级为只读缓存）。 */
  online: boolean;
  /**
   * 当前保存状态。
   *
   * 为什么要有它：自动保存最大的问题是"用户不知道存没存"。没有状态提示时，
   * 关页面之前只能靠猜——这正是数据丢失最常见的成因。有了这个状态，
   * 工具栏能明确显示「已保存 / 保存中 / 未保存 / 保存失败」。
   */
  saveState: "idle" | "pending" | "saving" | "saved" | "error";
  /** 最近一次成功保存的时间（毫秒时间戳）。 */
  lastSavedAt: number | null;
  /** 存储文件路径（设置里展示，出问题时能直接找到）。 */
  file: string;
  /**
   * 历史栈的可撤销/可重做状态。
   *
   * 放进快照而不是让 UI 去问 store.canUndo()：后者读的是栈内部变量，
   * 不参与 React 的依赖比较，按钮禁用态会一直停在初始值。
   */
  historyState: { canUndo: boolean; canRedo: boolean };
}

/** 读缓存（只读降级用）。 */
function readCache(): MindDocSummary[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as MindDocSummary[]) : [];
  } catch {
    return [];
  }
}

/** 写缓存。 */
function writeCache(docs: MindDocSummary[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(docs));
  } catch {
    /* 配额满了就算了，缓存不是权威 */
  }
}

/**
 * 创建导图 store：持有视图状态，暴露动作给组件。
 * 组件通过 useSyncExternalStore 订阅，store 不依赖 React。
 */
export interface MindmapStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ViewState;
  boot(): Promise<void>;
  /** 刷新列表。 */
  refresh(): Promise<void>;
  /** 新建并打开。 */
  create(title?: string): Promise<void>;
  /** 打开一份文档。 */
  open(id: string): Promise<void>;
  /** 回到列表。 */
  back(): void;
  /** 展开 / 收起右侧 Markdown 栏。 */
  showMarkdown(): void;
  /** 关 Markdown 面板回到画布。 */
  closeMarkdown(): void;
  /** 改当前树（会触发防抖保存）。 */
  mutate(root: MindDoc["root"]): void;
  /** 改文档标题（同样防抖保存）。 */
  retitle(title: string): void;
  /** 立即保存（不等防抖）。 */
  flush(): Promise<void>;
  /**
   * 取当前文档所有图片的字节映射（内嵌导出用）。
   * @returns id → { data, type }；取不到的图片不在结果里（导出时退化成路径）。
   */
  imageData(): Promise<Record<string, { data: string; type: string }>>;
  /** 导出图片包：返回文件名 → base64。 */
  exportImages(): Promise<Array<{ name: string; data: string; type: string }>>;
  /** 撤销上一步编辑；返回是否真的撤销了。 */
  undo(): void;
  /** 重做；返回是否真的重做了。 */
  redo(): void;
  /** 当前是否可撤销 / 重做（按钮禁用态用）。 */
  canUndo(): boolean;
  canRedo(): boolean;
  /**
   * 把 Markdown 的编辑合并回树。
   *
   * 关键：走 mergeTree 而不是整棵重建 —— 节点上的图片、拖动位置、
   * 折叠状态必须保留，改几个字不该把图全丢掉。
   *
   * @param entries - 解析出来的新结构。
   * @returns 合并统计；没有变化时返回 undefined。
   */
  applyMarkdown(entries: import("../core/parse.ts").ParsedEntry[]): { added: number; removed: number; changed: number } | undefined;
  /**
   * 设置节点样式。
   * @param id - 目标节点。
   * @param patch - 要改的字段；值为 null 表示恢复该项默认。
   * @param subtree - 是否连带应用到所有子孙。
   */
  styleNode(id: string, patch: Partial<Record<keyof import("../core/style.ts").NodeStyle, unknown>>, subtree?: boolean): void;
  /** 清除节点及其子树的自定义样式。 */
  clearStyle(id: string): void;
  /**
   * 批量设置样式（框选后用）。
   * @param ids - 目标节点；空数组时回落到当前选中集合。
   */
  styleNodes(
    ids: string[],
    patch: Partial<Record<keyof import("../core/style.ts").NodeStyle, unknown>>,
  ): void;
  /** 批量清除样式。 */
  clearStyles(ids: string[]): void;
  /**
   * 批量平移节点（框选后整体拖动）。
   * @param baseOf - 取节点当前自动布局坐标（画布提供，store 不持有布局）。
   */
  moveSelected(
    ids: string[],
    dx: number,
    dy: number,
    baseOf: (id: string) => { x: number; y: number } | undefined,
  ): void;
  /** 改文档标题（列表页用，走 Host 的 docs.rename）。 */
  rename(id: string, title: string): Promise<void>;
  /** 删除文档。 */
  remove(id: string): Promise<void>;
  /** 选中 / 取消选中节点。 */
  select(id: string | null): void;
  /** 选中 / 取消选中一条连线（传它的子节点 id）。 */
  selectEdge(id: string | null): void;
  /** 一次性选中多个（框选用）。 */
  selectMany(ids: string[]): void;
  /** 加选 / 减选一个（Shift 或 Cmd/Ctrl + 点击）。 */
  toggleSelect(id: string): void;
  /** 收起右侧属性抽屉（下次选中会重新展开）。 */
  hideStyle(): void;
  /** 进入 / 退出原地编辑。 */
  edit(id: string | null): void;
  /** 设置搜索词。 */
  search(query: string): void;
  /** 弹一条提示。 */
  toast(text: string, tone?: "info" | "error"): void;
  /** 卸载：清掉待保存定时器并尽力 flush。 */
  dispose(): void;
}

/** 创建 store。 */
export function createStore(): MindmapStore {
  let state: ViewState = {
    mode: "list",
    mdOpen: false,
    docs: [],
    doc: null,
    selectedId: null,
    selectedEdgeId: null,
    selectedFreeLinkId: null,
    selectedIds: [],
    styleOpen: false,
    editingId: null,
    query: "",
    loading: true,
    toast: null,
    online: true,
    saveState: "idle",
    lastSavedAt: null,
    file: "",
    historyState: { canUndo: false, canRedo: false },
  };

  const listeners = new Set<() => void>();
  let toastSeq = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> | undefined;
  /** 有未落盘的修改。 */
  let dirty = false;

  /**
   * 撤销栈。
   *
   * 只覆盖**当前打开文档的编辑**（节点增删改、拖动、图片、缩进、折叠），
   * 不覆盖标题改名与删文档——那些是文档级操作，数据结构不同（撤销删文档
   * 需要连图片字节一起恢复），超出这一层的职责。
   */
  const history: History = createHistory();

  /**
   * 应用一棵新树：记录历史、更新快照、安排保存。
   *
   * 抽成局部函数是因为调用点变多了（mutate / 样式 / Markdown 合并都会用到）。
   * 它是写树的**唯一**入口——所有会改变文档结构的路径都必须经过这里，
   * 否则那条路径就悄悄没有撤销、也没有保存。
   */
  const mutateTree = (root: MindNode): void => {
    if (state.doc === null) return;
    if (!history.canUndo()) {
      history.reset(
        state.doc.root,
        state.selectedId,
        state.doc.multiTheme === true,
        state.doc.links ?? [],
      );
    }
    history.push(root, state.selectedId, state.doc.multiTheme === true, state.doc.links ?? []);
    set({ doc: { ...state.doc, root, updatedAt: Date.now() } });
    syncHistory();
    scheduleSave();
  };

  /**
   * 文档级改动的统一入口：树 + 多主题标记 + 自由连线一起进快照。
   *
   * 自由连线不在树里，所以不能走 mutateTree（它只接受一棵树）。
   * 但它们和树一样要能撤销、要能自动保存，于是单开这个入口。
   */
  const pushDoc = (patch: { root?: MindNode; multiTheme?: boolean; links?: readonly MindLink[] }): void => {
    if (state.doc === null) return;
    const root = patch.root ?? state.doc.root;
    const multiTheme = patch.multiTheme ?? state.doc.multiTheme === true;
    const links = patch.links ?? state.doc.links ?? [];
    if (!history.canUndo()) {
      history.reset(state.doc.root, state.selectedId, state.doc.multiTheme === true, state.doc.links ?? []);
    }
    history.push(root, state.selectedId, multiTheme, links);
    const doc: MindDoc = { ...state.doc, root, updatedAt: Date.now() };
    if (multiTheme) doc.multiTheme = true;
    else delete doc.multiTheme;
    if (links.length > 0) doc.links = links.map((link) => ({ ...link }));
    else delete doc.links;
    set({ doc });
    syncHistory();
    scheduleSave();
  };

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const set = (patch: Partial<ViewState>): void => {
    state = { ...state, ...patch };
    emit();
  };

  /**
   * 同步历史栈的可用性到快照里。
   *
   * 所有会改动历史栈的地方（mutate / undo / redo / reset）都要调它一次，
   * 否则按钮禁用态会和真实状态脱节。
   */
  const syncHistory = (): void => {
    const next = { canUndo: history.canUndo(), canRedo: history.canRedo() };
    if (next.canUndo === state.historyState.canUndo && next.canRedo === state.historyState.canRedo) return;
    set({ historyState: next });
  };

  const toast = (text: string, tone: "info" | "error" = "info"): void => {
    toastSeq += 1;
    set({ toast: { text, tone, seq: toastSeq } });
    const seq = toastSeq;
    setTimeout(() => {
      // 只清自己那条：后面的提示不该被前一条的定时器抹掉
      if (state.toast?.seq === seq) set({ toast: null });
    }, tone === "error" ? 4200 : 2000);
  };

  /** 把一次请求失败的统一处理：标离线 + 提示。 */
  const handleError = (error: unknown, fallback: string): void => {
    const err = error instanceof ChannelError ? error : new ChannelError("unknown", (error as Error).message);
    if (err.code === "network" || err.code === "http" || err.code === "unauthorized" || err.code === "protocol") {
      set({ online: false });
    }
    toast(err.message.length > 0 ? err.message : fallback, "error");
  };

  /** 失败重试的次数（成功后归零）。 */
  let retryIndex = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const persist = async (): Promise<void> => {
    if (!dirty || state.doc === null) return;
    const doc = state.doc;
    dirty = false;
    set({ saveState: "saving" });
    try {
      const payload = await callHost<DocPayload>("docs.save", { doc });
      if (payload?.docs !== undefined) {
        writeCache(payload.docs);
        // 只更新列表，不改当前 doc —— 否则会把用户正在输入的光标位置冲掉
        set({ docs: payload.docs, online: true });
      }
      retryIndex = 0;
      set({ saveState: dirty ? "pending" : "saved", lastSavedAt: Date.now() });
    } catch (error) {
      dirty = true;
      set({ saveState: "error" });
      handleError(error, "保存失败，稍后自动重试");
      /*
       * 安排一次重试。
       *
       * 保存失败后如果只把 dirty 置回、等"下一次操作"，那些编辑就可能
       * 一直留在内存里（用户以为存好了，实际没有）。这里按退避表重试，
       * 最后一条延迟复用（30 秒），不会无限加密也不会放弃。
       */
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      const delay = SAVE_RETRY_DELAYS[Math.min(retryIndex, SAVE_RETRY_DELAYS.length - 1)];
      retryIndex += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        saving = saving === undefined ? persist() : saving.then(persist);
      }, delay);
    }
  };

  /** 安排一次防抖保存。 */
  const scheduleSave = (): void => {
    dirty = true;
    set({ saveState: "pending" });
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      saving = saving === undefined ? persist() : saving.then(persist);
    }, SAVE_DEBOUNCE);
  };

  const flush = async (): Promise<void> => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    saving = saving === undefined ? persist() : saving.then(persist);
    await saving;
  };

  /**
   * 页面即将离开时的"最后一搏"。
   *
   * 这是自动保存最容易漏掉、也是数据丢失最常发生的一格：
   * 用户改完立刻关标签页 / 刷新 / 切到别的页面，600ms 的防抖还没到，
   * 那次编辑就永远没了。
   *
   * 用 `fetch(..., { keepalive: true })` 而不是等异步队列：
   * 页面卸载后普通请求会被浏览器中止，keepalive 允许请求在卸载后继续发完。
   * 不 await（也没法 await），只求把请求发出去。
   *
   * 只发**有未保存修改**的情况，避免无谓请求。
   */
  const flushOnLeave = (): void => {
    if (!dirty || state.doc === null) return;
    const doc = state.doc;
    dirty = false;
    try {
      void fetch(CHANNEL + "/docs.save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          type: "client-request",
          rpcId: PLUGIN_ID + "-leave-" + String(Date.now()),
          method: "docs.save",
          payload: { doc },
        }),
      });
    } catch {
      /* 卸载阶段没有补救手段，失败就失败 */
    }
  };

  /*
   * 离开页面前的保存兜底。
   *
   * 三个事件各有分工，缺一不可：
   *   - visibilitychange -> hidden：切标签页、切 App 时触发，**最可靠**
   *     （移动端 pagehide 有时不触发，但这个会）。用户切走再也没回来
   *     的情况很常见，此时必须已经落盘。
   *   - pagehide：关闭标签页、导航离开时触发，用 keepalive 发请求。
   *   - beforeunload：桌面端刷新/关闭前的最后一道，作为兜底。
   *
   * 三个都挂是因为没有哪个在全部浏览器/全部场景下都保证触发。
   * 重复触发无害：dirty 一旦被清掉，后续调用直接返回。
   */
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") flushOnLeave();
  };
  const onPageHide = (): void => flushOnLeave();
  const onBeforeUnload = (): void => flushOnLeave();

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
  }

  const removeLeaveListeners = (): void => {
    if (typeof document === "undefined") return;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot() {
      return state;
    },

    async boot() {
      try {
        const payload = await callHost<ListPayload>("docs.list");
        writeCache(payload.docs);
        set({ docs: payload.docs, loading: false, online: true, file: payload.file });
      } catch (error) {
        // 通道不可用：给出缓存列表，但明确标成离线，不让用户误以为它还能保存
        set({ docs: readCache(), loading: false, online: false });
        handleError(error, "无法连接导图存储");
      }
    },

    async refresh() {
      try {
        const payload = await callHost<ListPayload>("docs.list");
        writeCache(payload.docs);
        set({ docs: payload.docs, online: true, file: payload.file });
      } catch (error) {
        handleError(error, "刷新失败");
      }
    },

    async create(title = "") {
      try {
        const payload = await callHost<DocPayload>("docs.create", {
          title: title.trim().length > 0 ? title : "未命名导图",
        });
        writeCache(payload.docs);
        history.reset(
          payload.doc.root,
          payload.doc.root.id,
          payload.doc.multiTheme === true,
          payload.doc.links ?? [],
        );
        set({
          docs: payload.docs,
          doc: payload.doc,
          mode: "edit",
          selectedId: payload.doc.root.id,
          editingId: null,
          online: true,
          // 历史刚复位，快照里的可用性也必须一起归零。
          // 漏了这一行，按钮会保持上一步文档的禁用态（实测：新建后
          // canUndo 仍是 true，但树里只有根节点 —— 撤销键亮着却无事可撤）。
          historyState: { canUndo: false, canRedo: false },
        });
      } catch (error) {
        handleError(error, "新建失败");
      }
    },

    async open(id) {
      // 切文档前先把上一份的改动落盘，否则切走就丢了
      await flush();
      try {
        const payload = await callHost<{ doc: MindDoc }>("docs.get", { id });
        // 切换文档必须清空历史：A 的撤销步不能应用到 B 上
        history.reset(
          payload.doc.root,
          payload.doc.root.id,
          payload.doc.multiTheme === true,
          payload.doc.links ?? [],
        );
        set({
          doc: payload.doc,
          mode: "edit",
          selectedId: payload.doc.root.id,
          editingId: null,
          online: true,
          historyState: { canUndo: false, canRedo: false },
        });
      } catch (error) {
        handleError(error, "打开失败");
      }
    },

    back() {
      void flush();
      set({ mode: "list", editingId: null });
    },

    showMarkdown() {
      void flush();
      // 只切换右侧栏，不动画布与选中态
      set({ mdOpen: !state.mdOpen, editingId: null });
    },

    closeMarkdown() {
      set({ mdOpen: false });
    },

    mutate(root) {
      mutateTree(root);
    },

    undo() {
      if (state.doc === null) return;
      const step = history.undo();
      if (step === undefined) {
        toast("没有可撤销的操作");
        return;
      }
      set({
        doc: {
          ...state.doc,
          root: step.root,
          /*
           * multiTheme 必须跟着回滚。
           *
           * 它决定"根节点渲染不渲染"：单主题时根就是中心节点，多主题时根只是
           * 不渲染的容器。只回滚树不回滚标记，撤销"新增主题"就会得到
           * "多主题标记 + 单主题树"——容器根不渲染，真正的根节点凭空消失。
           */
          multiTheme: step.multiTheme,
          ...(step.links.length > 0 ? { links: step.links } : {}),
          updatedAt: Date.now(),
        },
        selectedId: step.selectedId,
        editingId: null,
      });
      syncHistory();
      scheduleSave();
    },

    redo() {
      if (state.doc === null) return;
      const step = history.redo();
      if (step === undefined) {
        toast("没有可重做的操作");
        return;
      }
      set({
        doc: {
          ...state.doc,
          root: step.root,
          multiTheme: step.multiTheme,
          ...(step.links.length > 0 ? { links: step.links } : { links: undefined }),
          updatedAt: Date.now(),
        },
        selectedId: step.selectedId,
        editingId: null,
      });
      syncHistory();
      scheduleSave();
    },

    canUndo() {
      return state.historyState.canUndo;
    },

    canRedo() {
      return state.historyState.canRedo;
    },

    retitle(title) {
      if (state.doc === null) return;
      set({ doc: { ...state.doc, title } });
      scheduleSave();
    },

    flush,

    applyMarkdown(entries) {
      if (state.doc === null) return undefined;
      let counter = 0;
      const result = mergeTree(state.doc.root, entries, () => {
        counter += 1;
        return "md-" + Date.now().toString(36) + "-" + String(counter);
      });
      if (result === undefined) {
        toast("Markdown 里没有任何节点，已忽略", "error");
        return undefined;
      }
      if (!result.dirty) {
        toast("内容没有变化");
        return undefined;
      }
      history.push(result.root, state.selectedId);
      set({ doc: { ...state.doc, root: result.root, updatedAt: Date.now() } });
      syncHistory();
      scheduleSave();
      return { added: result.added, removed: result.removed, changed: result.changed };
    },

    styleNode(id, patch, subtree = false) {
      if (state.doc === null) return;
      const next = subtree
        ? applyStyleToSubtree(state.doc.root, id, patch, cloneNode, locate)
        : applyStyle(state.doc.root, id, patch, cloneNode, locate);
      if (next === undefined) return;
      mutateTree(next);
    },

    clearStyle(id) {
      if (state.doc === null) return;
      const next = clearNodeStyle(state.doc.root, id, cloneNode, locate);
      if (next === undefined) return;
      mutateTree(next);
    },

    styleNodes(ids, patch) {
      if (state.doc === null) return;
      const targets = ids.length > 0 ? ids : state.selectedIds;
      if (targets.length === 0) return;
      const next = applyStyleToMany(state.doc.root, targets, patch, cloneNode, locate);
      if (next === undefined) return;
      mutateTree(next);
    },

    clearStyles(ids) {
      if (state.doc === null) return;
      const targets = ids.length > 0 ? ids : state.selectedIds;
      if (targets.length === 0) return;
      const next = clearStyleMany(state.doc.root, targets, cloneNode, locate);
      if (next === undefined) return;
      mutateTree(next);
    },

    addTheme(position) {
      if (state.doc === null) return undefined;
      const multi = state.doc.multiTheme === true;
      // 主题数量上限沿用节点上限：主题本身也是节点
      if (countNodes(state.doc.root) >= MAX_NODES) {
        toast("节点数量已达上限，无法再加主题", "error");
        return undefined;
      }
      /*
       * 新主题用**空文字**：紧接着会进入编辑态，用户直接打字就是主题名。
       * 给个默认文字"新主题"的话，打字会追加在后面变成"新主题xxx"——
       * 和其它新建节点的行为也不一致（Tab 建子节点就是空文本）。
       */
      const result = addTheme(state.doc.root, multi, "", position);
      /*
       * 这里不能走 mutateTree：它用的是"当前 doc 的 multiTheme"，
       * 而新增主题**就是要把它从 false 改成 true**。
       * 所以手动 push，并且明确传新的标记值。
       */
      history.push(result.root, result.themeId, true);
      set({
        doc: { ...state.doc, root: result.root, multiTheme: true, updatedAt: Date.now() },
        selectedId: result.themeId,
        selectedIds: [result.themeId],
        styleOpen: true,
        editingId: result.themeId,
      });
      syncHistory();
      scheduleSave();
      toast(multi ? "已新增一个主题" : "已开启多主题：原来的主题变成了第一个");
      return result.themeId;
    },

    toggleMark(id, key) {
      if (state.doc === null) return false;
      const found = locate(state.doc.root, id);
      if (found === undefined) return false;
      if (!found.node.marks?.includes(key) && marksFull(found.node.marks)) {
        toast("一个节点最多 " + String(MAX_MARKS) + " 个标识", "error");
        return false;
      }
      const next = toggleMark(state.doc.root, id, key);
      if (next === undefined) return false;
      mutateTree(next);
      return true;
    },

    setEdgeLabel(id, text) {
      if (state.doc === null) return;
      const next = setEdgeLabel(state.doc.root, id, text);
      if (next === undefined) {
        toast("根节点上方没有连线，不能加文字", "error");
        return;
      }
      mutateTree(next);
    },

    detachEdge(childId, position) {
      if (state.doc === null) return false;
      /*
       * 断开连线 = 只把那条线去掉，**节点留在原父级下**：
       * 层级、样式、子树都不变，只是按当前位置悬浮（用户要求 v0.18.0）。
       * 早期实现是"升格成自由主题"，会让节点跳到顶层、层级和样式一起变。
       */
      // 不传坐标：断开不改变树结构，自动布局会把它留在原位
      const next = disconnectNode(state.doc.root, childId);
      if (next === undefined) {
        toast("这条连线断不开（根节点没有上级，主题本身也没有连线）", "error");
        return false;
      }
      mutateTree(next);
      toast("已断开连线（节点还在原位）");
      return true;
    },

    setFreeLinkStyle(id, style) {
      if (state.doc === null) return;
      const next = setLinkStyle(state.doc.links, id, style);
      if (next === undefined) return;
      // 和父子连线一致：改一次就记成文档默认
      set({
        doc: {
          ...state.doc,
          links: next,
          linkStyle: style ?? "solid",
          updatedAt: Date.now(),
        },
      });
      pushDoc({ links: next });
      scheduleSave();
    },

    setEdgeStyle(id, style) {
      if (state.doc === null) return;
      const next = setEdgeStyle(state.doc.root, id, style);
      if (next === undefined) {
        toast("这条线改不了（根节点没有入边）", "error");
        return;
      }
      /*
       * 同时记住成文档默认值：用户改了一次线型，多半希望后面的线也这样，
       * 而不是每加一个节点都回来改一次。
       */
      set({
        doc: {
          ...state.doc,
          root: next,
          linkStyle: style ?? "solid",
          updatedAt: Date.now(),
        },
      });
      pushDoc({ root: next });
      scheduleSave();
    },

    sortByPosition() {
      if (state.doc === null) return;
      const next = sortSiblingsByPosition(state.doc.root);
      // 顺序没变就不产生撤销步（拖动常常只是挪个位置）
      if (next === undefined) return;
      mutateTree(next);
    },

    setNodeKind(id, kind, position) {
      if (state.doc === null) return;
      const result = setNodeKind(
        state.doc.root,
        id,
        kind,
        state.doc.multiTheme === true,
        position,
        // 层级由连线决定：有连线就挂到连线另一端，没有就是 1 级
        state.doc.links ?? [],
      );
      if (result === undefined) {
        toast(
          kind === "node"
            ? "它没有连到任何节点，按规则就是 1 级节点；先连一条线再切子节点"
            : "改不了这个节点的种类",
          "error",
        );
        return;
      }
      history.push(result.root, id, result.multiTheme, state.doc.links ?? []);
      set({
        doc: {
          ...state.doc,
          root: result.root,
          multiTheme: result.multiTheme,
          updatedAt: Date.now(),
        },
        selectedId: id,
        selectedIds: [id],
        editingId: null,
      });
      syncHistory();
      scheduleSave();
      toast(kind === "theme" ? "已设为主题" : "已设为子节点");
    },

    repointEdge(oldChildId, newChildId, position) {
      if (state.doc === null) return false;
      const result = repointEdge(
        state.doc.root,
        state.doc.multiTheme === true,
        oldChildId,
        newChildId,
        position,
      );
      if (result === undefined) {
        toast("这条线改不到那个节点（不能连到自己的子孙上）", "error");
        return false;
      }
      history.push(result.root, result.movedId, result.multiTheme);
      set({
        doc: {
          ...state.doc,
          root: result.root,
          multiTheme: result.multiTheme,
          updatedAt: Date.now(),
        },
        selectedId: result.movedId,
        selectedIds: [result.movedId],
        selectedEdgeId: null,
        editingId: null,
      });
      syncHistory();
      scheduleSave();
      toast("已改接到这个节点");
      return true;
    },

    reparent(id, newParentId) {
      if (state.doc === null) return false;
      if (id === newParentId) {
        toast("不能连到自己身上", "error");
        return false;
      }
      const next = reparentNode(state.doc.root, id, newParentId);
      if (next === undefined) {
        // 三种失败：环、根节点、已经连着这个父级
        const isRoot = state.doc.root.id === id;
        const isCycle = pathTo(state.doc.root, newParentId).some((node) => node.id === id);
        toast(
          isRoot
            ? "根节点没有上级，不能改连线"
            : isCycle
              ? "不能连到自己的子节点上（会形成环）"
              : "已经连着这个节点了",
          "error",
        );
        return false;
      }
      mutateTree(next);
      toast("已改为挂在这个节点下");
      return true;
    },

    duplicate(ids) {
      if (state.doc === null) return [];
      const targets = ids !== undefined && ids.length > 0 ? ids : state.selectedIds;
      if (targets.length === 0) {
        toast("先选一个节点再复制");
        return [];
      }
      const result = duplicateNodes(state.doc.root, targets);
      if (result === undefined) {
        // 两种失败：选的是根节点（没有同级），或节点数超上限
        const onlyRoot = targets.length === 1 && targets[0] === state.doc.root.id;
        toast(
          onlyRoot
            ? "根节点没有同级，不能复制（可以复制它的子节点）"
            : "复制失败：可能是节点数量已达上限",
          "error",
        );
        return [];
      }
      mutateTree(result.root);
      // 直接 set 而不是调 this.selectMany：对象字面量里 this 的绑定不可靠
      // （早先 this.mutate 就踩过同一个坑）
      set({
        selectedIds: result.ids,
        selectedId: result.ids[result.ids.length - 1] ?? null,
        styleOpen: true,
        editingId: null,
      });
      toast(result.ids.length > 1 ? `已复制 ${String(result.ids.length)} 组节点` : "已复制");
      return result.ids;
    },

    moveSelected(ids, dx, dy, baseOf) {
      if (state.doc === null) return;
      const next = moveNodes(state.doc.root, ids, dx, dy, baseOf);
      if (next === undefined) return;
      mutateTree(next);
    },

    async imageData() {
      const doc = state.doc;
      if (doc === null) return {};
      const ids: Array<{ id: string; type: string }> = [];
      const walk = (node: { images?: Array<{ id: string; type: string }>; children: unknown[] }): void => {
        for (const image of node.images ?? []) ids.push({ id: image.id, type: image.type });
        for (const child of node.children) walk(child as typeof node);
      };
      walk(doc.root);
      if (ids.length === 0) return {};

      const out: Record<string, { data: string; type: string }> = {};
      await Promise.all(
        ids.map(async (image) => {
          try {
            const payload = await callHost<{ data: string; type: string }>("assets.get", image);
            out[image.id] = { data: payload.data, type: payload.type };
          } catch {
            /* 单张取不到不影响其他图片 */
          }
        }),
      );
      return out;
    },

    async exportImages() {
      const doc = state.doc;
      if (doc === null) return [];
      const payload = await callHost<{ files: Array<{ name: string; data: string; type: string }> }>(
        "assets.export",
        { id: doc.id },
      );
      return payload.files;
    },

    async rename(id, title) {
      const value = title.trim();
      if (value.length === 0) return;
      try {
        const payload = await callHost<DocPayload>("docs.rename", { id, title: value });
        writeCache(payload.docs);
        set({
          docs: payload.docs,
          // 改的可能就是当前打开那份，标题要同步过去
          ...(state.doc?.id === id ? { doc: { ...state.doc, title: payload.doc.title } } : {}),
        });
        toast("已改名");
      } catch (error) {
        handleError(error, "改名失败");
      }
    },

    async remove(id) {
      try {
        const payload = await callHost<{ docs: MindDocSummary[] }>("docs.remove", { id });
        writeCache(payload.docs);
        set({
          docs: payload.docs,
          // 删的就是当前打开的那份，退回列表
          ...(state.doc?.id === id ? { doc: null, mode: "list" as const } : {}),
        });
        toast("已删除");
      } catch (error) {
        handleError(error, "删除失败");
      }
    },

    selectEdge(id) {
      set({ selectedEdgeId: id, selectedFreeLinkId: null });
    },

    selectFreeLink(id) {
      set({ selectedFreeLinkId: id, selectedEdgeId: null });
    },

    addFreeLink(from, to) {
      if (state.doc === null) return false;
      if (from === to) {
        toast("不能连到节点自己身上", "error");
        return false;
      }
      /*
       * 连线一建立就自动调整层级（用户规则）：
       * 有一端还是 1 级节点，就把它挂到另一端下面。
       * 挂靠成功后这条线**不再保留**——父子关系已经用树结构表达了，
       * 再画一条自由连线就重复了。
       */
      const attached = attachByLink(state.doc.root, from, to, state.doc.multiTheme === true);
      if (attached !== undefined) {
        const moved = locate(attached.root, attached.childId);
        const label = moved?.node.text ?? "";
        history.push(attached.root, attached.childId, state.doc.multiTheme === true, state.doc.links ?? []);
        set({
          doc: {
            ...state.doc,
            root: attached.root,
            updatedAt: Date.now(),
          },
          selectedId: attached.childId,
          selectedIds: [attached.childId],
        });
        syncHistory();
        scheduleSave();
        toast("已把「" + label + "」挂到上级下面");
        return true;
      }

      const next = addLink(state.doc.links, from, to);
      if (next === undefined) {
        toast("这两个节点之间已经有一条连线了", "error");
        return false;
      }
      pushDoc({ links: next });
      toast("已连好一条关系线");
      return true;
    },

    removeFreeLink(id) {
      if (state.doc === null) return;
      const current = state.doc.links ?? [];
      /*
       * 不能只看 removeLink 的返回值：它在"删完还剩"和"id 不存在"两种情况下
       * 都会走不同的分支，早先写成"返回 undefined 才提交"，于是删一条剩一条时
       * 什么都不做（列表里两条线删不掉）。这里先确认 id 确实存在。
       */
      if (!current.some((link) => link.id === id)) return;
      pushDoc({ links: current.filter((link) => link.id !== id) });
    },

    setFreeLinkLabel(id, text) {
      if (state.doc === null) return;
      const next = setLinkLabel(state.doc.links, id, text);
      if (next === undefined && (state.doc.links ?? []).every((l) => l.id !== id)) return;
      pushDoc({ links: next ?? [] });
    },

    select(id) {
      set({
        selectedId: id,
        selectedIds: id === null ? [] : [id],
        // 选节点时清掉连线选中：两套高亮同时亮着会让人分不清"现在操作的是什么"
        selectedEdgeId: null,
        // 选中即展开属性抽屉；取消选中时收起
        styleOpen: id !== null,
      });
    },

    hideStyle() {
      set({ styleOpen: false });
    },

    selectMany(ids) {
      // 去重并保持顺序：框选时同一个节点可能被多次命中
      const unique = [...new Set(ids)];
      set({
        selectedIds: unique,
        // 主选中项取最后一个：用户最后划到/点到的那个，符合直觉
        selectedId: unique.length > 0 ? unique[unique.length - 1] : null,
        styleOpen: unique.length > 0,
        editingId: null,
      });
    },

    toggleSelect(id) {
      const current = state.selectedIds;
      const has = current.includes(id);
      const next = has ? current.filter((item) => item !== id) : [...current, id];
      set({
        selectedIds: next,
        selectedId: next.length > 0 ? next[next.length - 1] : null,
        styleOpen: next.length > 0,
        editingId: null,
      });
    },

    edit(id) {
      set({
        editingId: id,
        ...(id !== null ? { selectedId: id, selectedIds: [id] } : {}),
      });
    },

    search(query) {
      set({ query });
    },

    toast,

    dispose() {
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = undefined;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      removeLeaveListeners();
      void flush();
    },
  };
}
