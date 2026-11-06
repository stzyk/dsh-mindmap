/**
 * dsh-mindmap — 节点标识（图标）。
 *
 * 用途：在节点上挂一个小图标标记重难点、高频考点、疑问等，
 * 复习时一眼能扫出来，不用逐个读文字。
 *
 * 为什么是**固定一组**而不是让用户随便填 emoji：
 *   ① 自由填写的图标在深色/浅色主题下对比度不可控，可能出现看不清的图标；
 *   ② 固定集合才能做"按标识筛选"这类后续功能；
 *   ③ 一组十几个已经够表达常见语义，再多用户也记不住。
 */

export interface Mark {
  /** 存进数据的稳定 key（不要改，改了就丢历史数据）。 */
  key: string;
  /** 画布上显示的符号。 */
  glyph: string;
  /** 面板上显示的中文名。 */
  label: string;
  /** 悬停提示。 */
  hint: string;
}

/** 可选的节点标识。顺序即面板上的显示顺序。 */
export const MARKS: readonly Mark[] = [
  { key: "star", glyph: "⭐", label: "重点", hint: "重点内容" },
  { key: "fire", glyph: "🔥", label: "高频", hint: "高频考点" },
  { key: "warn", glyph: "⚠️", label: "易错", hint: "容易出错" },
  { key: "ask", glyph: "❓", label: "疑问", hint: "还没搞懂" },
  { key: "idea", glyph: "💡", label: "想法", hint: "灵光一现 / 延伸想法" },
  { key: "todo", glyph: "⏰", label: "待办", hint: "待补充 / 待确认" },
  { key: "done", glyph: "✅", label: "已掌握", hint: "已经掌握" },
  { key: "flag", glyph: "🚩", label: "关键", hint: "关键结论" },
] as const;

/**
 * 一个节点最多挂几个标识。
 *
 * 4 个是"还能一眼看明白"的上限：再多就变成一串 emoji，
 * 反而看不出重点，而且会把节点撑得很宽。
 */
export const MAX_MARKS = 4;

const BY_KEY = new Map(MARKS.map((mark) => [mark.key, mark]));

/** 按 key 查标识定义。 */
export function markOf(key: string): Mark | undefined {
  return BY_KEY.get(key);
}

/**
 * 规范化标识数组：丢掉未知 key、去重、限量。
 *
 * @returns 合法数组；没有有效标识时返回 undefined（不写进节点，保持数据干净）。
 */
export function normalizeMarks(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const key = entry.trim();
    if (!BY_KEY.has(key)) continue;
    if (out.includes(key)) continue;
    out.push(key);
    if (out.length >= MAX_MARKS) break;
  }
  return out.length > 0 ? out : undefined;
}

/** 切换某个标识（有则去掉，没有则加上）。 */
export function toggleMarkIn(marks: readonly string[] | undefined, key: string): string[] | undefined {
  if (!BY_KEY.has(key)) return marks === undefined ? undefined : [...marks];
  const current = marks ?? [];
  if (current.includes(key)) {
    const next = current.filter((entry) => entry !== key);
    return next.length > 0 ? next : undefined;
  }
  // 已经满了就不再加（调用方负责提示）
  if (current.length >= MAX_MARKS) return [...current];
  return [...current, key];
}

/** 这个节点是不是已经挂满了标识。 */
export function marksFull(marks: readonly string[] | undefined): boolean {
  return (marks?.length ?? 0) >= MAX_MARKS;
}
