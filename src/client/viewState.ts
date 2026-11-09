/**
 * dsh-mindmap — 记住每份导图的视口位置（滚动 + 缩放）。
 *
 * 为什么放 localStorage 而不是文档里：
 *   视口位置是**视图偏好**，不是文档内容。塞进文档会导致
 *   "滚动一下 → 文档变脏 → 触发自动保存"，白写磁盘还污染撤销语义。
 *   放本地也只对这台机器有意义（换设备各看各的，本来就该这样）。
 */

export interface SavedView {
  /** 滚动位置（px，含虚拟留白偏移）。 */
  left: number;
  top: number;
  /** 缩放比例。 */
  zoom: number;
}

const PREFIX = "dsh-mindmap:view:";

/** 读某份文档上次的视口位置；没有或数据坏了返回 undefined。 */
export function loadView(docId: string): SavedView | undefined {
  try {
    const raw = window.localStorage.getItem(PREFIX + docId);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<SavedView>;
    const left = typeof parsed.left === "number" && Number.isFinite(parsed.left) ? parsed.left : undefined;
    const top = typeof parsed.top === "number" && Number.isFinite(parsed.top) ? parsed.top : undefined;
    const zoom = typeof parsed.zoom === "number" && Number.isFinite(parsed.zoom) ? parsed.zoom : undefined;
    if (left === undefined || top === undefined || zoom === undefined) return undefined;
    return { left, top, zoom };
  } catch {
    // 隐私模式 / 存储被禁用 / 数据被手改坏：当成"没存过"，不要影响打开文档
    return undefined;
  }
}

/** 记下某份文档的视口位置。失败静默忽略。 */
export function saveView(docId: string, view: SavedView): void {
  try {
    window.localStorage.setItem(PREFIX + docId, JSON.stringify(view));
  } catch {
    /* 存不下就算了，不能因为记视图位置影响编辑 */
  }
}
