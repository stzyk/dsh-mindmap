/**
 * dsh-mindmap — 节点文字被截断时的悬停提示。
 *
 * 为什么不用原生 `title`：它有两个实际问题——
 *   ① 延迟约 1 秒，用户以为没有提示就走了；
 *   ② 完全不可控（样式、位置、换行都由浏览器决定），
 *      长文本会变成一条横贯屏幕的超宽浮条。
 *
 * 所以自己画：鼠标停在**被截断**的节点上约 350ms 后，在节点下方弹一个
 * 限宽、可换行的浮层，显示完整文字。没被截断的节点不弹（否则满屏都是提示，
 * 反而更吵）。
 *
 * 挂到 document.body 而不是画布内：画布是 `overflow: auto` 的滚动容器，
 * 放在里面会被裁掉——这和灯箱踩的是同一个坑。
 */

import * as React from "react";
import { createPortal } from "react-dom";

/** 悬停提示要显示的内容与锚点。 */
export interface TooltipState {
  /** 完整文字。 */
  text: string;
  /** 锚点节点的屏幕坐标（用于定位）。 */
  rect: { left: number; top: number; bottom: number; width: number };
}

/** 鼠标停留多久才弹出（毫秒）。 */
const SHOW_DELAY = 350;
/** 浮层最大宽度。 */
const MAX_WIDTH = 320;

/**
 * 判断一个元素里的文字是否被截断。
 *
 * 只比较 `scrollWidth` 与 `clientWidth`：现在节点文字是单行 + ellipsis，
 * 横向溢出即等于被截断。用 `> 1` 而不是 `> 0`，避免亚像素取整造成误判。
 */
export function isTruncated(element: HTMLElement | null): boolean {
  if (element === null) return false;
  return element.scrollWidth > element.clientWidth + 1;
}

/** 悬停提示浮层。 */
export function NodeTooltip({ state }: { state: TooltipState | null }): React.ReactElement | null {
  if (state === null) return null;

  /*
   * 定位：默认挂在节点下方居中。
   *
   * 这里只做一次粗略夹取（不让它跑出视口左右边缘），不做"上方/下方自动翻转"：
   * 导图节点本来就在画布中间居多，翻转逻辑的复杂度换不来实际收益。
   */
  const half = Math.min(MAX_WIDTH, state.text.length * 13 + 24) / 2;
  const centerX = state.rect.left + state.rect.width / 2;
  const left = Math.max(8, Math.min(centerX - half, window.innerWidth - half * 2 - 8));

  return createPortal(
    <div
      className="mm-tooltip"
      data-mm-panel="tooltip"
      role="tooltip"
      style={{
        left,
        top: state.rect.bottom + 6,
        maxWidth: MAX_WIDTH,
      }}
    >
      {state.text}
    </div>,
    document.body,
  );
}

/**
 * 悬停提示的调度器。
 *
 * 抽成 hook 是为了把"何时弹、何时收"这套时序集中在一处：
 * 鼠标移出、滚动、选中变化都必须能立刻收起，否则浮层会留在原地变成幽灵。
 *
 * @param enabled - 为 false 时不弹（比如正在编辑、正在拖动的节点）。
 */
export function useNodeTooltip(enabled: boolean): {
  state: TooltipState | null;
  onEnter: (event: React.MouseEvent<HTMLElement>, text: string) => void;
  onLeave: () => void;
  hide: () => void;
} {
  const [state, setState] = React.useState<TooltipState | null>(null);
  const timerRef = React.useRef<number | undefined>(undefined);

  const hide = React.useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    setState(null);
  }, []);

  const onEnter = React.useCallback(
    (event: React.MouseEvent<HTMLElement>, text: string) => {
      if (!enabled) return;
      const el = event.currentTarget.querySelector("span");
      if (!isTruncated(el as HTMLElement | null)) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        setState({
          text,
          rect: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width },
        });
      }, SHOW_DELAY);
    },
    [enabled],
  );

  const onLeave = React.useCallback(() => {
    hide();
  }, [hide]);

  // 编辑态、卸载时都要收起，避免浮层残留
  React.useEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);

  React.useEffect(() => () => hide(), [hide]);

  return { state, onEnter, onLeave, hide };
}
