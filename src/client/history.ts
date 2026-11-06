/**
 * dsh-mindmap — 撤销 / 重做栈（纯逻辑）。
 *
 * 策略：**快照栈**，不是命令栈。
 *
 * 为什么选快照：命令栈需要为每种操作写一对 undo/redo（加节点要记住插在哪、
 * 拖动要记住旧坐标、删节点要记住整棵子树……），漏一个就是"撤销后数据坏了"。
 * 快照只需要一个 `structuredClone`，任何新操作自动获得撤销能力，不会漏。
 *
 * 快照的代价是内存。这里用三道闸把它压住：
 *   1. 只存**导图树**（root），不存标题/时间戳这些无关状态；
 *   2. 深度上限 100 步，超出丢最老的；
 *   3. 同一个树对象引用不重复入栈（连续 setState 但内容没变时不堆历史）。
 *
 * 树的规模已有上限（5000 节点 / 单节点 24 图），所以单份快照是可控的。
 */

import { type MindLink, type MindNode } from "../core/tree.ts";

/** 历史深度上限：100 步足够覆盖一次连续编辑，再多就是浪费内存。 */
export const MAX_HISTORY = 100;

/** 一步历史。 */
interface Step {
  /** 该步之后的树（结构化克隆，与任何外部引用无关）。 */
  root: MindNode;
  /** 该步对应的选中节点（撤销时顺便把焦点放回去，用户不会"不知道自己在哪"）。 */
  selectedId: string | null;
  /**
   * 该步是不是多主题模式。
   *
   * 必须进快照：它决定"根节点渲染不渲染"——单主题时根就是中心节点，
   * 多主题时根只是个不渲染的容器。只回滚树不回滚这个标记的话，
   * 撤销"新增主题"会得到"多主题标记 + 单主题树"的坏状态：
   * 容器根不渲染、真正的根节点凭空消失，看起来像数据丢了。
   */
  multiTheme: boolean;
  /**
   * 该步的自由连线。
   *
   * 和 multiTheme 同理：它不在树里，但会影响渲染，所以必须进快照。
   * 漏了它，撤销一次"加连线"会留下指向不存在关系的坏状态。
   */
  links: MindLink[];
}

/** 一步历史的内容（撤销/重做返回这个）。 */
export interface HistoryState {
  root: MindNode;
  selectedId: string | null;
  multiTheme: boolean;
  links: MindLink[];
}

/** 撤销栈句柄。 */
export interface History {
  /** 记录一步新状态（会清空 redo 栈）。 */
  push(root: MindNode, selectedId: string | null, multiTheme?: boolean, links?: readonly MindLink[]): void;
  /** 撤销：返回上一步；无可撤销时返回 undefined。 */
  undo(): HistoryState | undefined;
  /** 重做：返回下一步；无可重做时返回 undefined。 */
  redo(): HistoryState | undefined;
  /** 是否可以撤销 / 重做。 */
  canUndo(): boolean;
  canRedo(): boolean;
  /** 当前历史步数（诊断与测试用）。 */
  size(): number;
  /** 清空（切换文档时调用，避免把 A 的历史应用到 B 上）。 */
  reset(root?: MindNode, selectedId?: string | null, multiTheme?: boolean, links?: readonly MindLink[]): void;
}

/**
 * 创建历史栈。
 * @param options.maxSteps - 深度上限，默认 MAX_HISTORY。
 */
export function createHistory(options: { maxSteps?: number } = {}): History {
  const maxSteps = Math.max(2, options.maxSteps ?? MAX_HISTORY);

  /** past 的最后一项是"当前状态"，因此初始为空时表示还没有任何快照。 */
  let past: Step[] = [];
  let future: Step[] = [];

  /** 深拷贝一份树：快照必须与后续修改完全隔离。 */
  const snapshot = (root: MindNode): MindNode => structuredClone(root);
  /** 连线数组也要深拷贝：和树一样，快照必须与后续修改隔离。 */
  const cloneLinks = (links: readonly MindLink[] | undefined): MindLink[] =>
    links === undefined ? [] : links.map((link) => ({ ...link }));
  /** 两份连线是否等价（顺序不同也算不同，顺序就是用户的操作顺序）。 */
  const sameLinks = (a: readonly MindLink[], b: readonly MindLink[]): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i]!;
      const y = b[i]!;
      if (x.id !== y.id || x.from !== y.from || x.to !== y.to || (x.label ?? "") !== (y.label ?? "")) {
        return false;
      }
    }
    return true;
  };

  return {
    push(root, selectedId, multiTheme = false, links = []) {
      /*
       * 内容没变就不入栈：React 有些路径会重设同一个 tree（例如只改了选中态），
       * 那不该占掉一步撤销额度。
       *
       * multiTheme 也要参与判断：单主题 -> 多主题时树是变了的，
       * 但反过来如果只有标记变了（理论上不会），也得入栈。
       */
      const last = past[past.length - 1];
      if (
        last !== undefined &&
        sameTree(last.root, root) &&
        last.multiTheme === multiTheme &&
        sameLinks(last.links, links)
      ) {
        // 但选中节点可能变了，更新一下引用，撤销时焦点更准
        last.selectedId = selectedId;
        return;
      }
      past.push({ root: snapshot(root), selectedId, multiTheme, links: cloneLinks(links) });
      if (past.length > maxSteps) past.shift();
      // 新操作让 redo 分支失效——这是所有编辑器的通行语义
      future = [];
    },

    undo() {
      if (past.length < 2) return undefined;
      // 当前位置入 future，回到前一步
      const current = past.pop()!;
      future.push(current);
      const previous = past[past.length - 1]!;
      // 返回副本：调用方可能直接把它塞进 React state 并被后续操作改写
      return {
        root: snapshot(previous.root),
        selectedId: previous.selectedId,
        multiTheme: previous.multiTheme,
        links: cloneLinks(previous.links),
      };
    },

    redo() {
      const next = future.pop();
      if (next === undefined) return undefined;
      past.push(next);
      return {
        root: snapshot(next.root),
        selectedId: next.selectedId,
        multiTheme: next.multiTheme,
        links: cloneLinks(next.links),
      };
    },

    canUndo() {
      return past.length >= 2;
    },

    canRedo() {
      return future.length > 0;
    },

    size() {
      return past.length;
    },

    reset(root, selectedId = null, multiTheme = false, links = []) {
      past = [];
      future = [];
      if (root !== undefined) past.push({ root: snapshot(root), selectedId, multiTheme, links: cloneLinks(links) });
    },
  };
}

/**
 * 判断两棵树是否结构相同。
 *
 * 用于"内容没变就别入栈"。比较的是**内容**不是引用：上层可能因为
 * 无关字段变化而重建了树对象，那种情况不该产生一步撤销。
 */
export function sameTree(a: MindNode, b: MindNode): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.text !== b.text) return false;
  if ((a.note ?? "") !== (b.note ?? "")) return false;
  /*
   * 连线文字也要比。
   *
   * v0.5.0 就栽过一次同样的坑：加了 style 字段却没同步到 sameTree，
   * 只改样式被判成"没变化"，撤销栈不入栈、撤销键一直灰着。
   * 加任何新字段都要回来补这里。
   */
  if ((a.edgeLabel ?? "") !== (b.edgeLabel ?? "")) return false;
  // 标识也要比（加字段就要回来补这里，见 edgeLabel 那段注释）
  const aMarks = (a.marks ?? []).join(",");
  const bMarks = (b.marks ?? []).join(",");
  if (aMarks !== bMarks) return false;
  if ((a.collapsed === true) !== (b.collapsed === true)) return false;
  const pa = a.position;
  const pb = b.position;
  if (pa === undefined || pb === undefined) {
    if (pa !== pb) return false;
  } else if (pa.x !== pb.x || pa.y !== pb.y) {
    return false;
  }
  /*
   * 样式也必须比较。
   *
   * 漏掉这一项时，"只改了样式"的操作会被 sameTree 判成"没有变化"，
   * 于是 history.push 直接 return —— 用户调了颜色/字号，撤销键却还是灰的，
   * 改错了也退不回去。这是实测踩到的：设完边框样式，canUndo 仍是 false。
   */
  const sa = a.style;
  const sb = b.style;
  if (sa === undefined || sb === undefined) {
    if (sa !== sb) return false;
  } else if (
    (sa.color ?? "") !== (sb.color ?? "") ||
    (sa.fontSize ?? 0) !== (sb.fontSize ?? 0) ||
    (sa.bold === true) !== (sb.bold === true) ||
    (sa.italic === true) !== (sb.italic === true) ||
    (sa.radius ?? -1) !== (sb.radius ?? -1) ||
    (sa.borderWidth ?? -1) !== (sb.borderWidth ?? -1)
  ) {
    return false;
  }

  const ia = a.images ?? [];
  const ib = b.images ?? [];
  if (ia.length !== ib.length) return false;
  for (let i = 0; i < ia.length; i += 1) {
    if (ia[i]!.id !== ib[i]!.id || (ia[i]!.caption ?? "") !== (ib[i]!.caption ?? "")) return false;
  }
  if (a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i += 1) {
    if (!sameTree(a.children[i]!, b.children[i]!)) return false;
  }
  return true;
}
