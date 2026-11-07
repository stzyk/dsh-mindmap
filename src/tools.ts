/**
 * dsh-mindmap — 模型可调用的工具（Host 半区）。
 *
 * 让对话能直接读写导图：读结构、生成新图、增量修改。
 *
 * 设计取舍：
 *   - **读**返回带节点 id 的缩进文本。AI 必须能看到 id，否则只能靠文字猜，
 *     改错节点是必然的。
 *   - **改**用增量操作而不是整棵树替换：能精确定位、能只撤销这一步。
 *   - **生成**接受 Markdown 大纲，复用现有的 parseMarkdown——AI 对 Markdown
 *     天然熟练，比让它输出 JSON 树可靠得多。
 */

import { parseMarkdown } from "./core/parse.ts";
import {
  insertChild,
  insertSibling,
  locate,
  moveSibling,
  pathTo,
  removeNode,
  setText,
  type MindNode,
} from "./core/tree.ts";
import { safeFileName } from "./core/markdown.ts";

/** 文档存储的最小接口（和 store.ts 的实现对齐，异步）。 */
export interface ToolStore {
  /** 摘要里的字段是 nodeCount，不是 nodes（写错会显示 undefined）。 */
  list(): Array<{ id: string; title: string; nodeCount: number; updatedAt: number }>;
  get(id: string): { id: string; title: string; root: MindNode } | undefined;
  create(title: string, rootText?: string): Promise<{ id: string }>;
  save(input: unknown): Promise<{ id: string }>;
}

/** 一次增量修改。 */
export interface MindOp {
  op: "add" | "update" | "remove" | "move";
  /** 目标节点 id（add 时为父节点，可省略表示根）。 */
  id?: string;
  /** add / update 的文字。 */
  text?: string;
  /** move 的方向。 */
  direction?: "up" | "down";
}

/** 把树渲染成带 id 的缩进文本，供模型阅读。 */
export function outlineOf(root: MindNode, maxNodes = 800): string {
  const lines: string[] = [];
  let count = 0;
  const walk = (node: MindNode, depth: number): void => {
    if (count >= maxNodes) return;
    count += 1;
    const text = node.text.length > 0 ? node.text : "（空节点）";
    lines.push("  ".repeat(depth) + "- " + text + "  [" + node.id + "]");
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  if (count >= maxNodes) lines.push("…（节点过多，已截断）");
  return lines.join("\n");
}

/** 把一次修改应用到树上，返回新树或错误说明。 */
export function applyOps(
  root: MindNode,
  ops: readonly MindOp[],
): { root: MindNode; applied: number } | { error: string } {
  let current = root;
  let applied = 0;

  for (const [index, op] of ops.entries()) {
    const at = "第 " + String(index + 1) + " 个操作";
    if (op.op === "add") {
      const text = (op.text ?? "").trim();
      if (text.length === 0) return { error: at + "：add 缺少 text" };
      const next =
        op.id === undefined ? insertSibling(current, current.id, text) : insertChild(current, op.id, text);
      if (next === undefined) return { error: at + "：找不到父节点 " + String(op.id) };
      current = next;
      applied += 1;
      continue;
    }
    if (op.op === "update") {
      if (op.id === undefined) return { error: at + "：update 缺少 id" };
      const next = setText(current, op.id, op.text ?? "");
      if (next === undefined) return { error: at + "：找不到节点 " + op.id };
      current = next;
      applied += 1;
      continue;
    }
    if (op.op === "remove") {
      if (op.id === undefined) return { error: at + "：remove 缺少 id" };
      const next = removeNode(current, op.id);
      if (next === undefined) return { error: at + "：删不掉 " + op.id + "（根节点不可删）" };
      current = next;
      applied += 1;
      continue;
    }
    if (op.op === "move") {
      if (op.id === undefined) return { error: at + "：move 缺少 id" };
      const dir = op.direction === "down" ? 1 : -1;
      const next = moveSibling(current, op.id, dir);
      if (next === undefined) return { error: at + "：挪不动 " + op.id };
      current = next;
      applied += 1;
      continue;
    }
    return { error: at + "：未知操作 " + String((op as { op?: string }).op) };
  }

  return { root: current, applied };
}

/** 从 Markdown 建树。 */
export function treeFromMarkdown(markdown: string, title: string): MindNode {
  // parseMarkdown 返回 { entries, warnings }，不是数组
  const { entries } = parseMarkdown(markdown);
  const parsed = entries;
  if (parsed.length === 0) {
    return { id: "root", text: title, children: [] };
  }
  /*
   * parseMarkdown 返回的是扁平条目（带 depth），这里拼回树。
   * 根节点用标题，条目挂到它下面。
   */
  const root: MindNode = { id: "root", text: title, children: [] };
  const stack: Array<{ depth: number; node: MindNode }> = [{ depth: -1, node: root }];
  let serial = 0;
  for (const entry of parsed) {
    const node: MindNode = { id: "n" + String(serial++), text: entry.text, children: [] };
    while (stack.length > 1 && stack[stack.length - 1]!.depth >= entry.depth) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    parent.children.push(node);
    stack.push({ depth: entry.depth, node });
  }
  return root;
}

/** 节点总数。 */
export function countOf(root: MindNode): number {
  let n = 0;
  const walk = (node: MindNode): void => {
    n += 1;
    for (const child of node.children) walk(child);
  };
  walk(root);
  return n;
}

/** 找一份文档：给了 id 就用 id，否则按标题模糊匹配。 */
export function resolveDoc(
  store: ToolStore,
  id: string | undefined,
  title: string | undefined,
): { id: string; title: string } | undefined {
  if (id !== undefined && id.length > 0) {
    const found = store.list().find((doc) => doc.id === id);
    return found === undefined ? undefined : { id: found.id, title: found.title };
  }
  if (title !== undefined && title.trim().length > 0) {
    const needle = title.trim();
    const exact = store.list().find((doc) => doc.title === needle);
    if (exact !== undefined) return { id: exact.id, title: exact.title };
    const loose = store.list().find((doc) => doc.title.includes(needle) || needle.includes(doc.title));
    if (loose !== undefined) return { id: loose.id, title: loose.title };
  }
  return undefined;
}

/** 文件名（导出用）。 */
export { safeFileName };

/** 节点 id 是否存在。 */
export function hasNode(root: MindNode, id: string): boolean {
  return locate(root, id) !== undefined;
}

/** 从根到某节点的路径（用于提示 AI 上下文）。 */
export function pathTextOf(root: MindNode, id: string): string {
  const trail = pathTo(root, id);
  return trail.map((node) => node.text).join(" / ");
}

/**
 * 把工具的 DSL 参数/输出描述转成**标准 JSON Schema**。
 *
 * DSH 的 `defineTool` 会做这件事，但它是宿主内部的包，插件不该直接依赖。
 * 不转换的后果很严重：DSL 里的 `required: true` 会原样发给模型侧，
 * 那不是合法的 JSON Schema，上游直接 400（code 1210「API 调用参数不合法」）。
 *
 * 转换规则（和 defineTool 一致）：
 *   - 属性上的 `required: true` → 收进父级的 `required: [...]` 数组
 *   - 其余键原样保留（type / description / enum / items / properties …）
 */
export function toJsonSchema(spec: Record<string, unknown>): Record<string, unknown> {
  const convert = (node: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === "required") continue;
      if (key === "properties" && value !== null && typeof value === "object") {
        const props: Record<string, unknown> = {};
        for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
          if (child === null || typeof child !== "object") continue;
          const childSpec = child as Record<string, unknown>;
          if (childSpec.required === true) required.push(name);
          props[name] = convert(childSpec);
        }
        out.properties = props;
        continue;
      }
      if (key === "items" && value !== null && typeof value === "object") {
        out.items = convert(value as Record<string, unknown>);
        continue;
      }
      out[key] = value;
    }
    if (required.length > 0) out.required = required;
    return out;
  };
  return convert(spec);
}
