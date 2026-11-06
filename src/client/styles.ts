/**
 * dsh-mindmap — 样式表。
 *
 * 全部颜色走宿主的 `--dsw-alias-*` 主题变量：插件必须跟着用户当前的主题
 * （亮色 / 暗色 / 换肤插件）走，写死颜色会在深色模式下变成一片惨白。
 *
 * 设计取向——「工程图纸」而不是「彩色便签」：
 *   导图工具很容易滑向五颜六色的圆角小卡片，那种东西截图好看、真用起来
 *   噪点太多。这里反过来：整体是中性纸面，结构和层级靠**线**（贝塞尔连线、
 *   左侧竖线、层级缩进）和**字重**表达，颜色只留一个强调色给"当前选中"。
 *   这样一张 60 节点的图不会花，也符合 DSH 本体的克制气质。
 *
 * 类名前缀 mm- 统一，避免和宿主样式打架。
 */

/** 样式表 id：卸载时按 id 整张移除。 */
export const STYLE_ID = "dsh-mindmap-styles";

export const CSS = `
/* ── 外壳 ─────────────────────────────────────────────── */
.mm-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif;
}
.mm-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  flex: none;
  flex-wrap: wrap;
}
.mm-bar-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: .01em;
  margin-right: 2px;
  flex: none;
}
.mm-grow { flex: 1; min-width: 0; }

/* ── 按钮 ─────────────────────────────────────────────── */
.mm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background: transparent;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease;
  white-space: nowrap;
}
.mm-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05));
}
.mm-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: 1px;
}
.mm-btn:disabled { opacity: .4; cursor: not-allowed; }
.mm-btn[data-primary="true"] {
  background: var(--dsw-alias-button-primary-fill, #4a7dff);
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-weight: 500;
}
.mm-btn[data-primary="true"]:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-fill, #4a7dff);
  opacity: .88;
}
.mm-btn[data-danger="true"]:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(220,60,60,.1));
  color: var(--dsw-alias-label-error, #c0392b);
  border-color: var(--dsw-alias-state-error-primary, #c0392b);
}
.mm-btn[data-ghost="true"] { border-color: transparent; }
.mm-btn[data-icon="true"] { padding: 0; width: 28px; flex: none; }

/* ── 文档列表 ─────────────────────────────────────────── */
.mm-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}
.mm-doc {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 9px 10px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.mm-doc:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.mm-doc:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: -2px;
}
.mm-doc-main { min-width: 0; flex: 1; }
.mm-doc-title {
  font-size: 13.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mm-doc-meta {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  margin-top: 1px;
  font-variant-numeric: tabular-nums;
}
.mm-doc-actions { display: flex; gap: 2px; opacity: 0; flex: none; }
.mm-doc:hover .mm-doc-actions,
.mm-doc:focus-within .mm-doc-actions { opacity: 1; }

/* ── 空态 ─────────────────────────────────────────────── */
.mm-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px 24px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.mm-empty-head { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-secondary, #5a5a5a); }
.mm-empty-body { font-size: 12.5px; max-width: 34ch; line-height: 1.7; }

/* ── 画布 / Markdown 分栏 ─────────────────────────────── */
/*
 * 左画布、右 Markdown，可拖动分隔条（用 CSS resize 之外的方式太重，
 * 这里先给固定比例 + 窄屏折叠，够用且不会把画布挤没）。
 */
.mm-split {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
}
.mm-split-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.mm-split-side {
  flex: none;
  width: 42%;
  min-width: 260px;
  max-width: 720px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .08));
  background: var(--dsw-alias-bg-base, #fff);
}

/*
 * 属性抽屉比 Markdown 栏窄：它是"调参"，不需要读长文本。
 * 必须放在 .mm-split-side 之后——两者权重相同，靠源码顺序覆盖 width。
 */
.mm-split[data-md-open] .mm-split-style,
.mm-split-style {
  width: 288px;
  min-width: 240px;
  max-width: 360px;
}
/* 窄屏：上下堆叠而不是横向挤压（否则画布只剩一条缝） */
@media (max-width: 900px) {
  .mm-split[data-md-open="true"] {
    flex-direction: column;
  }
  .mm-split-side {
    width: auto;
    max-width: none;
    min-width: 0;
    height: 40%;
    border-left: none;
    border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .08));
  }
}

/* ── 画布浮动操作条 ───────────────────────────────────── */
/*
 * 钉在可视区左上角，不随画布滚动移动（否则拖到深树里就找不到了）。
 * 底色用一个半透明面板色，让它从点阵背景上浮起来又不挡路。
 */
.mm-actions {
  /* 在滚动区外面的一条独立横条：位置稳定，不随画布滚动，也不压节点 */
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .08));
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, transparent);
}
.mm-actions-hint {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  margin-left: 2px;
}

/* ── 画布 ─────────────────────────────────────────────── */
.mm-canvas-wrap {
  flex: 1;
  min-height: 0;
  /*
   * 纯视口，不再滚动。
   *
   * 用 transform 平移画布（见 Canvas 的 pan 状态）而不是滚动容器：
   * 滚动量被内容尺寸卡死，画布一放大或内容一多就到头了；
   * transform 没有边界，可以一直拖下去（无限画布）。
   */
  /* 滚动条回来了：滚动范围 = 内容 + 四周虚拟留白（见 Canvas 的 PAD） */
  overflow: auto;
  position: relative;
  background-image: radial-gradient(var(--dsw-alias-border-l1, rgba(0,0,0,.13)) 1px, transparent 1px);
  background-size: 18px 18px;
  background-position: 0 0;
}
/*
 * 右键平移中：光标变成"抓取"，给用户明确的反馈。
 * 只在 data-panning 时生效，平时保持默认。
 */
.mm-canvas-wrap[data-panning="true"] {
  cursor: grabbing;
}
.mm-canvas-wrap[data-panning="true"] * {
  cursor: grabbing !important;
}
.mm-canvas {
  /* 绝对定位在视口左上角，靠 transform 平移/缩放 */
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  will-change: transform;
  /* 容器只要可聚焦接键盘，不需要可见焦点圈：
     选中态由节点的 data-selected 表达，两套高亮会互相干扰 */
  outline: none;
}
.mm-canvas:focus,
.mm-canvas:focus-visible { outline: none; }
.mm-link {
  fill: none;
  stroke: var(--dsw-alias-border-l3, rgba(0,0,0,.22));
  stroke-width: 1.4;
  stroke-linecap: round;
  transition: stroke .12s ease, stroke-width .12s ease;
}
.mm-link[data-active="true"] {
  stroke: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke-width: 2;
}

/* ── 节点 ─────────────────────────────────────────────── */
.mm-node {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16));
  background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font-size: 13px;
  line-height: 1.3;
  cursor: pointer;
  user-select: none;
  transition: border-color .12s ease, background .12s ease, box-shadow .12s ease;
}
.mm-node:hover { border-color: var(--dsw-alias-border-l3, rgba(0,0,0,.3)); }
.mm-node span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
  text-align: center;
}
/*
 * 根节点（中心主题）。
 *
 * 早先的做法是把文字色当背景色、把页面底色当前景色，靠"反色"突出根节点。
 * 这在默认主题下能跑，但底色与文字色是两个**语义不同**的变量：换肤
 * （如 data-dsh-skin=xp）之后它们不再成对，实际渲染出来是一整块纯黑，
 * 文字与背景同色，看不见也看不清。
 *
 * 现在的做法不依赖任何变量配对：前景色始终是 label-primary，根节点只靠
 * 「加粗 + 更深一层的填充 + 更明显的描边」表达层级。这样无论皮肤怎么改，
 * 文字与背景永远来自同一套语义（label 系列 vs bg 系列），对比度由宿主保证。
 */
.mm-node[data-root="true"] {
  background: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-primary, #1a1a1a);
  border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, .3));
  border-width: 1.5px;
  font-weight: 600;
  font-size: 13.5px;
}
.mm-node[data-depth="1"] { font-weight: 500; }
.mm-node[data-selected="true"] {
  border-color: var(--dsw-alias-state-business-primary, #4a7dff);
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4a7dff);
}
.mm-node[data-root="true"][data-selected="true"] {
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4a7dff);
}
.mm-node[data-on-path="true"]:not([data-selected="true"]) {
  border-color: var(--dsw-alias-state-business-primary, #4a7dff);
}
.mm-node[data-collapsed="true"] span { padding-right: 12px; }
/* 拖动中：抬起一点、加阴影、光标变抓取态，给"手上有东西"的反馈 */
.mm-node[data-dragging="true"] {
  cursor: grabbing;
  z-index: 20;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .16);
  transition: none;
  opacity: .92;
}
/* 带手动坐标的节点：左侧一道短竖线标记"这个是我摆的"，不抢视觉 */
.mm-node[data-manual="true"]::before {
  content: "";
  position: absolute;
  left: -1px;
  top: 50%;
  translate: 0 -50%;
  width: 2px;
  height: 12px;
  border-radius: 1px;
  background: var(--dsw-alias-state-business-primary, #4a7dff);
  opacity: .55;
}
/* ── 节点内的图片 ─────────────────────────────────────── */
/*
 * 图片排在文字下方，与文字之间保留间距。用 flex 纵向排列，
 * 宽度由内容决定（布局已经算好了节点宽高）。
 */
.mm-node-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  align-items: center;
  max-width: 100%;
  margin-top: 4px;
}
.mm-node-img {
  display: block;
  object-fit: contain;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, .04));
  flex: none;
  cursor: pointer;
  transition: opacity .12s ease;
}
.mm-node-img:hover { opacity: .85; }
/* 缩略图双击看大图：光标给个"能放大"的暗示 */
img.mm-node-img { cursor: zoom-in; }
/* 占位与丢失两种状态：尺寸一致，避免图片到达后布局跳动 */
.mm-node-img-loading {
  display: block;
  border-radius: 4px;
  background: var(--dsw-alias-bg-skeleton, rgba(127, 127, 127, .12));
  animation: mm-pulse 1.4s ease-in-out infinite;
}
.mm-node-img-missing {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(0, 0, 0, .2));
  border-radius: 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  text-align: center;
}
@keyframes mm-pulse {
  0%, 100% { opacity: .55; }
  50% { opacity: .85; }
}
/* 节点里有图片时改为纵向排布（文字在上，图片在下） */
.mm-node:has(.mm-node-imgs) {
  flex-direction: column;
  padding-top: 6px;
  padding-bottom: 6px;
}
.mm-node:has(.mm-node-imgs) span {
  /* 文字单行截断的规则在图片节点里放宽，避免把图挤走 */
  flex: none;
}

/* 拖入文件时的整块画布反馈：一眼知道"松手就加进来" */
.mm-canvas-wrap[data-drop-active="true"] {
  outline: 2px dashed var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: -6px;
  background-color: var(--dsw-alias-bg-multi-select, rgba(74, 125, 255, .06));
}

/* 拖动时整块画布用抓取光标，提示"这里能拖" */
.mm-node { cursor: grab; }
.mm-node[data-editing="true"] {
  cursor: text;
  /*
   * 编辑时让方框包住输入框，而不是"小方框套大输入框"。
   *
   * 非编辑态的宽高是布局按**已提交文字**算的固定值（内联样式）；
   * 编辑时改用内容撑开（内联宽高已在 JSX 里省掉），
   * 方框和输入框就始终贴合。定位由 JSX 改成以原中心为基准平移，
   * 所以是向四周对称展开，不会只往右下鼓。
   */
  width: auto;
  height: auto;
  overflow: visible;
  z-index: 8;
  /* 编辑框自己有内嵌焦点框，节点外壳再描一圈会重复 */
  box-shadow: none;
}
.mm-node:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: 2px;
}
.mm-node[data-editing="true"] {
  cursor: text;
  /* 编辑时输入框自己会画一圈蓝框，节点外壳让位，避免出现双层边框 */
  border-color: transparent;
  box-shadow: none;
}
/*
 * 节点内联编辑框。
 *
 * 三个属性都必须显式写死，不能靠 inherit / transparent：
 *   - background-color 而不是 background：部分皮肤给 input 设了 background
 *     简写，简写会连带重置 background-color，用长写更稳。
 *   - color 显式取 label-primary：父节点在根节点场景下可能是任意强调色，
 *     inherit 会让输入的文字与编辑框底色撞色（曾经白底白字）。
 *   - caret-color 跟随前景色，否则光标在深色底上可能完全看不见。
 */
/*
 * 编辑框（textarea）。
 *
 * 关键点：
 *   - 默认就是**一行高**，随内容自动增高（早期设过固定 44px 下限，
 *     结果短文字的编辑框比方框高一大截）；
 *   - 内容多时靠 JS 自动增高，超出节点方框的部分**允许溢出显示**
 *     （见 .mm-node[data-editing] 的 overflow: visible），
 *     否则长文本又被裁掉，等于没改；
 *   - resize: none：拖拽手柄会破坏节点布局，而且没有意义。
 */
.mm-node-input {
  width: 100%;
  /*
   * 宽度由 JS 按"节点自身宽度 / 草稿实测宽度"给出（见 Canvas 的 editorWidth），
   * 这里只兜底一个很小的下限，避免空节点时窄成一条线。
   *
   * 不要把 min-height 设成 40 这类固定值：那会强制编辑框至少两行高，
   * 短文字时方框被撑得又高又空（用户反馈"默认修改文本框太大"）。
   * 高度交给 JS 的自动增高（scrollHeight）算，单行文字就是一行高。
   */
  min-width: 60px;
  min-height: 0;
  /*
   * 必须是 border-box。
   *
   * 自动增高的算法是 height = scrollHeight + 2。scrollHeight **已经包含 padding**，
   * 若这里是 content-box，padding 会被再加一次：每渲染一轮就多涨 8px，
   * 单行文字也能撑成两行高（实测 30px 内容涨到 38px 显示）。
   */
  box-sizing: border-box;
  border: none;
  background-color: transparent;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  caret-color: currentColor;
  font: inherit;
  line-height: 1.45;
  text-align: center;
  outline: none;
  padding: 4px 2px;
  /* 根节点自己有更深的填充，编辑框仍要保持透明，露出方框本来的底 */
  background-image: none;
  /* 编辑时的焦点反馈：一圈内嵌细框，不占布局、不和节点外壳重复 */
  border-radius: 4px;
  box-shadow: inset 0 0 0 1.5px var(--dsw-alias-state-business-primary, #4a7dff);
  /* 换行而不是横向溢出；长单词也允许断开 */
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  resize: none;
  overflow: hidden;
}
.mm-node[data-root="true"] .mm-node-input {
  /* 根节点文字是常规色，底色是 layer-3，两者由宿主保证对比度 */
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
/* 折叠按钮：贴在方框右边缘的小圆点，内容量是它唯一要表达的事 */
/*
 * 折叠按钮：跟在文字后面（inline），不再绝对定位到右边缘。
 *
 * 原来它贴在节点右边框上，正好压在连线端点上——两个小圆挤在一起，
 * 点折叠却误拖了线，点端点又误折叠。放到文字后面既避开冲突，
 * 也和"这个按钮属于这个节点"的语义一致。
 */
.mm-fold {
  flex: none;
  margin-left: 4px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2));
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-secondary, #666);
  font: 10px/13px ui-monospace, SFMono-Regular, Menlo, monospace;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  transition: border-color .12s ease, color .12s ease;
}
.mm-fold:hover {
  border-color: var(--dsw-alias-state-business-primary, #4a7dff);
  color: var(--dsw-alias-state-business-primary, #4a7dff);
}

/* ── 工具栏 / 快捷键提示 ───────────────────────────────── */
.mm-hints {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 7px 14px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.mm-hints kbd {
  font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 2px 4px;
  border-radius: 3px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.03));
  color: var(--dsw-alias-label-secondary, #5a5a5a);
}

/* ── 标题输入 ─────────────────────────────────────────── */
.mm-title-input {
  min-width: 0;
  flex: 1;
  max-width: 340px;
  padding: 5px 9px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: inherit;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
}
.mm-title-input:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary, #4a7dff);
}

/* ── Markdown 面板 ────────────────────────────────────── */
.mm-md-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #fff);
}
.mm-md-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  flex-wrap: wrap;
}
.mm-md-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.mm-md-text {
  flex: 1;
  width: 100%;
  border: none;
  resize: none;
  padding: 14px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font: 12.5px/1.75 ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", monospace;
  outline: none;
  white-space: pre;
  overflow: auto;
  tab-size: 2;
}
.mm-md-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .08));
  flex-wrap: wrap;
}
.mm-md-hint {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.mm-md-dirty {
  font-size: 11.5px;
  color: var(--dsw-alias-state-warn-label, #b8791a);
  font-weight: 500;
}
.mm-md-preview {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 14px 18px;
  border-left: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  font-size: 13px;
  line-height: 1.75;
}
.mm-md-preview h1 { font-size: 19px; margin: 14px 0 8px; font-weight: 600; }
.mm-md-preview h2 { font-size: 16px; margin: 13px 0 6px; font-weight: 600; }
.mm-md-preview h3 { font-size: 14.5px; margin: 11px 0 5px; font-weight: 600; }
.mm-md-preview h4,
.mm-md-preview h5,
.mm-md-preview h6 { font-size: 13px; margin: 10px 0 4px; font-weight: 600; }
.mm-md-preview h1:first-child,
.mm-md-preview h2:first-child,
.mm-md-preview h3:first-child { margin-top: 0; }
.mm-md-preview ul { margin: 4px 0; padding-left: 20px; }
.mm-md-preview li { margin: 1px 0; }
.mm-md-preview blockquote {
  margin: 6px 0;
  padding: 2px 0 2px 11px;
  border-left: 2px solid var(--dsw-alias-border-l3, rgba(0,0,0,.2));
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  font-size: 12.5px;
}

/* ── 缩放控件 ─────────────────────────────────────────── */
/* 撑出滚动范围的虚拟留白层：只占位、不显示 */
.mm-canvas-space {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}
.mm-zoom {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 6px;
  padding-left: 8px;
  border-left: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .1));
}
.mm-zoom-btn {
  min-width: 26px;
  padding: 0 6px;
  font-size: 14px;
  line-height: 1;
}
.mm-zoom-value {
  min-width: 48px;
  height: 26px;
  padding: 0 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.mm-zoom-value:hover {
  background: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.mm-zoom-value:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: 1px;
}

/* ── 节点属性面板 ─────────────────────────────────────── */
/*
 * 固定在画布下方的一条栏。放底部而不是浮窗：
 * 调颜色需要反复试，面板必须稳定可见、不遮住正在看的节点。
 */
/*
 * 属性抽屉：占据右侧一整列，纵向排列。
 *
 * 从"画布下方横条"改过来：横条挤占画布高度，导图一深就得上下滚；
 * 抽屉只占宽度，画布高度不变。
 */
.mm-style {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #fff);
  padding: 10px 12px 8px;
  overflow: auto;
}
.mm-style-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
  /*
   * 抽屉在右列内部，底部的「恢复默认」不再贴着屏幕右下角，
   * 也就不会再被宿主的桌面宠物浮层盖住（横条时期曾踩过这个坑）。
   */
}
.mm-style-title {
  font-size: 12.5px;
  font-weight: 600;
  flex: none;
}
.mm-style-target {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  max-width: 28ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, .12));
}
.mm-style-scope {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary, #5a5a5a);
}
.mm-style-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.mm-style-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
}
.mm-style-label {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  flex: none;
  min-width: 28px;
}
.mm-style-options {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
/* 色块 / 档位按钮：小、密、选中时描一圈 */
.mm-style-chip {
  min-width: 26px;
  height: 24px;
  padding: 0 7px;
  border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .14));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: border-color .1s ease, box-shadow .1s ease;
  white-space: nowrap;
}
.mm-style-chip:hover {
  border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, .3));
}
.mm-style-chip[data-active="true"] {
  border-color: var(--dsw-alias-state-business-primary, #4a7dff);
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4a7dff);
}
.mm-style-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: 1px;
}
.mm-style-hint {
  margin-top: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}

/* ── 图片大图查看（灯箱） ─────────────────────────────── */
/*
 * 挂到 document.body 上（见 Lightbox.tsx 的说明），层级要压过宿主的一切
 * 浮层：番茄钟的提醒卡片用的是 2147483000，这里取一个比它更高但仍是
 * 合法 32 位整数的值，避免两者打架。
 */
.mm-lightbox {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, .72);
  backdrop-filter: blur(2px);
  animation: mm-lightbox-in .14s ease;
}
@keyframes mm-lightbox-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.mm-lightbox-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(20, 20, 24, .72);
  color: #fff;
}
.mm-lightbox-caption {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 46vw;
}
.mm-lightbox-spacer { flex: 1; }
.mm-lightbox-bar .mm-btn {
  /* 深色背景上必须换成浅色，否则按钮文字与背景糊在一起 */
  color: #fff;
  border-color: rgba(255, 255, 255, .28);
  background: rgba(255, 255, 255, .08);
}
.mm-lightbox-bar .mm-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, .18);
}
.mm-lightbox-scale {
  font-size: 12px;
  min-width: 42px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, .82);
}
.mm-lightbox-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow: auto;
}
.mm-lightbox-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, .5);
  transition: transform .12s ease;
  cursor: zoom-out;
}
.mm-lightbox-loading,
.mm-lightbox-missing {
  color: rgba(255, 255, 255, .78);
  font-size: 13px;
  padding: 24px;
}
.mm-lightbox-missing { color: #ffb4a8; }
.mm-lightbox-hint {
  flex: none;
  text-align: center;
  padding: 0 14px 14px;
  font-size: 11.5px;
  color: rgba(255, 255, 255, .58);
}

/* ── 提示条 ───────────────────────────────────────────── */
.mm-toast {
  position: absolute;
  left: 50%;
  bottom: 16px;
  translate: -50% 0;
  z-index: 8;
  max-width: calc(100% - 32px);
  padding: 7px 13px;
  border-radius: 999px;
  background: var(--dsw-alias-toast-bg, rgba(28,28,32,.94));
  color: var(--dsw-alias-toast-label, #fff);
  font-size: 12.5px;
  box-shadow: 0 6px 22px rgba(0,0,0,.18);
  pointer-events: none;
  animation: mm-toast-in .16s ease;
}
.mm-toast[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #c0392b); }
@keyframes mm-toast-in {
  from { opacity: 0; translate: -50% 6px; }
  to { opacity: 1; translate: -50% 0; }
}

/* ── 滚动条（跟宿主一致） ─────────────────────────────── */
.mm-list::-webkit-scrollbar,
.mm-canvas-wrap::-webkit-scrollbar,
.mm-md-text::-webkit-scrollbar,
.mm-md-preview::-webkit-scrollbar { width: 8px; height: 8px; }
.mm-list::-webkit-scrollbar-thumb,
.mm-canvas-wrap::-webkit-scrollbar-thumb,
.mm-md-text::-webkit-scrollbar-thumb,
.mm-md-preview::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(0,0,0,.18));
  border-radius: 4px;
}

/* ── 减少动效 ─────────────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  .mm-btn, .mm-node, .mm-link, .mm-fold { transition: none; }
  .mm-toast { animation: none; }
}

/* ── 框选 ─────────────────────────────────────────────── */
/*
 * 虚线框。用 outline 而不是 border：border 会占布局尺寸，
 * 让框比实际选区小一圈（1px 边框 + content-box）。
 * pointer-events: none 保证框本身不拦截指针事件。
 */
.mm-marquee {
  position: absolute;
  z-index: 1;
  pointer-events: none;
  border: 1px dashed var(--dsw-alias-state-business-primary, #4a7dff);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 10%, transparent);
  border-radius: 2px;
}
/* 多选中的节点：用较淡的描边区分"主选中"与"一起选中" */
.mm-node[data-multi="true"] {
  border-color: var(--dsw-alias-state-business-primary, #4a7dff);
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary, #4a7dff);
}

/* ── 保存状态 ─────────────────────────────────────────── */
/*
 * 一直可见的小状态灯。用颜色 + 文字双重编码：只靠颜色的话，
 * 色弱用户分辨不出「已保存」和「保存失败」。
 */
.mm-save-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.mm-save-state:hover {
  background: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.mm-save-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
.mm-save-state[data-state="saved"] {
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.mm-save-state[data-state="saved"] .mm-save-dot {
  background: var(--dsw-alias-state-success-primary, #2ea043);
}
.mm-save-state[data-state="pending"] .mm-save-dot {
  background: var(--dsw-alias-state-warn-label, #b8791a);
}
.mm-save-state[data-state="saving"] .mm-save-dot {
  background: var(--dsw-alias-state-business-primary, #4a7dff);
  animation: mm-pulse 1s ease-in-out infinite;
}
.mm-save-state[data-state="error"] {
  color: var(--dsw-alias-state-error-label, #c62828);
  border-color: var(--dsw-alias-state-error-label, #c62828);
}
.mm-save-state[data-state="error"] .mm-save-dot {
  background: var(--dsw-alias-state-error-label, #c62828);
}
@keyframes mm-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
}

/* ── 长文本悬停提示 ───────────────────────────────────── */
/*
 * 自己画的浮层（不用原生 title）：延迟短、样式可控、长文本能换行。
 * 挂 body 上，z-index 低于灯箱但高于画布与抽屉。
 */
.mm-tooltip {
  position: fixed;
  z-index: 2147483400;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #2b3038);
  color: var(--dsw-alias-label-primary, #f5f7fa);
  border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, .2));
  box-shadow: 0 4px 14px rgba(0, 0, 0, .18);
  font-size: 12.5px;
  line-height: 1.5;
  /* 长文本换行而不是撑成一条横线 */
  white-space: pre-wrap;
  word-break: break-word;
  pointer-events: none;
}

/* ── 连线：命中区 / 文字 / 拖动虚影 ───────────────────── */
/*
 * 线的视觉宽度只有 1.5px，直接点几乎点不中。叠一条透明的粗线专门接指针，
 * 视觉不变但可点范围大了十倍。
 */
.mm-link-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  pointer-events: stroke;
  cursor: grab;
}
.mm-link-hit:hover + .mm-link,
.mm-link-hit:active {
  cursor: grabbing;
}
/* 拖动连线时的虚影：表示"这条线正在被拖到某处" */
.mm-link-ghost {
  fill: none;
  stroke: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke-width: 2;
  stroke-dasharray: 5 4;
  pointer-events: none;
}
/* 连线上的文字 */
.mm-edge-label {
  position: absolute;
  transform: translate(-50%, -50%);
  /*
   * 标签不吃指针事件。
   *
   * 它压在连线上，如果吃事件，点标签就点不到下面的线了；
   * 而现在"点线 = 选中并编辑"，让事件穿透过去正好。
   * 也顺便避免了标签挡住节点上的点击。
   */
  pointer-events: none;
  /* 节点间距只有 54px，标签必然比间隙宽，所以画在节点**之上**才不会被盖住 */
  z-index: 4;
  max-width: 150px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, #fff);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .1));
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  font-size: 11.5px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
}

/* 连线文字编辑框 */
.mm-edge-input {
  position: absolute;
  transform: translate(-50%, -50%);
  width: 168px;
  height: 26px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1.5px solid var(--dsw-alias-state-business-primary, #4a7dff);
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font: inherit;
  font-size: 12px;
  outline: none;
  z-index: 9;
}

/* ── 节点图片：悬停操作 ───────────────────────────────── */
/*
 * 图片外面包一层，用来定位操作条。
 * 原来 img 是直接子元素，加操作条需要一个定位容器。
 */
/*
 * 注意：这里必须用 .mm-node .xxx 这种更高优先级。
 * 上面有一条针对 .mm-node 下所有 span 的宽泛规则（width: 100%、overflow: hidden），
 * 它同样命中图片容器和操作条——直接把操作条拉成整行宽、按钮挤到左边，
 * 还会把溢出的按钮裁掉。权重 0,2,0 > 0,1,1，能压过去。
 */
.mm-node .mm-node-img-box {
  position: relative;
  display: inline-block;
  width: auto;
  overflow: visible;
  flex: none;
  line-height: 0;
  text-align: left;
}
.mm-node-img-box > img {
  display: block;
}
/* 操作条：默认透明不可见，hover 才显现 */
.mm-node .mm-img-actions {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  overflow: visible;
  text-align: left;
  /* 不写这两行会被拉成整行宽，按钮就跑到左边去了 */
  width: fit-content;
  justify-content: flex-end;
  gap: 2px;
  opacity: 0;
  transition: opacity .12s ease;
  pointer-events: none;
}
.mm-node-img-box:hover .mm-img-actions {
  opacity: 1;
  pointer-events: auto;
}
.mm-img-btn {
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: rgba(20, 22, 26, .72);
  color: #fff;
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  cursor: pointer;
}
.mm-img-btn:hover {
  background: rgba(20, 22, 26, .92);
}
.mm-img-btn[data-danger="true"]:hover {
  background: var(--dsw-alias-state-error-label, #c62828);
}
.mm-img-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: 1px;
}

/* 属性面板：标识按钮 */
.mm-mark-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.mm-mark-chip[data-active="true"] {
  border-color: var(--dsw-alias-state-business-primary, #4a7dff);
  background: var(--dsw-alias-bg-layer-2, rgba(74, 125, 255, .12));
}

/* 属性面板：标签旁的"默认 / 当前 N"小标记 */
.mm-style-default,
.mm-style-current {
  margin-left: 4px;
  font-style: normal;
  font-size: 10px;
  padding: 0 3px;
  border-radius: 3px;
  vertical-align: middle;
}
.mm-style-default {
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, .05));
}
.mm-style-current {
  color: var(--dsw-alias-state-business-label, #4a7dff);
  background: var(--dsw-alias-bg-layer-2, rgba(74, 125, 255, .12));
}

/* ── 节点标识（⭐ 重点 等） ───────────────────────────── */
/*
 * 用 .mm-node .mm-marks 提高权重：上面有一条针对 .mm-node 下所有 span 的
 * 宽泛规则（width: 100%、overflow: hidden、text-overflow: ellipsis），
 * 不压过去的话图标会被拉成整行宽、还会被裁掉。
 */
.mm-node .mm-marks {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  width: auto;
  flex: none;
  overflow: visible;
  text-overflow: clip;
  /* emoji 的基线通常偏低，往下压一点点视觉上才和文字居中 */
  line-height: 1;
  transform: translateY(1px);
}
.mm-node .mm-mark {
  width: auto;
  flex: none;
  overflow: visible;
  font-size: 1.05em;
  line-height: 1;
}

/* 被点中的连线：加粗 + 变色，让"现在操作的是这条边"一眼可见 */
.mm-link[data-selected="true"] {
  stroke: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke-width: 2.5;
}

/* ── 连线的两端手柄与删除按钮 ─────────────────────────── */
/*
 * 连线本体只有 1.5px，靠"精确点在线上再拖"在密集的图里几乎做不到。
 * 手柄做成 11px 的圆点（r=5 + 描边），好点得多，
 * 而且"两端都能拖"这件事本身变得可见。
 */
.mm-edge-handle {
  fill: var(--dsw-alias-bg-base, #fff);
  stroke: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke-width: 2;
  cursor: grab;
  pointer-events: all;
}
.mm-edge-handle:hover {
  fill: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke: var(--dsw-alias-bg-base, #fff);
}
.mm-edge-handle:active {
  cursor: grabbing;
}
/* 中点删除按钮 */
.mm-edge-remove {
  cursor: pointer;
  pointer-events: all;
}
.mm-edge-remove circle {
  fill: var(--dsw-alias-bg-base, #fff);
  stroke: var(--dsw-alias-border-l1, rgba(0, 0, 0, .18));
  stroke-width: 1;
}
.mm-edge-remove path {
  stroke: var(--dsw-alias-label-secondary, #5a5a5a);
  stroke-width: 1.6;
  stroke-linecap: round;
  fill: none;
  pointer-events: none;
}
.mm-edge-remove:hover circle {
  fill: var(--dsw-alias-state-error-label, #c62828);
  stroke: var(--dsw-alias-state-error-label, #c62828);
}
.mm-edge-remove:hover path {
  stroke: #fff;
}

/* ── 自由连线（关系线） ─────────────────────────────── */
/*
 * 和父子连线用不同线型区分：实线 = 层级结构，虚线 = 我另外标的关联。
 */
.mm-free-link {
  stroke-dasharray: 6 4;
  opacity: .85;
}
.mm-free-link[data-selected="true"] {
  stroke: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke-width: 2.5;
  opacity: 1;
}
.mm-free-link-label {
  font-size: 11.5px;
  fill: var(--dsw-alias-label-secondary, #5a5a5a);
  paint-order: stroke;
  stroke: var(--dsw-alias-bg-base, #fff);
  stroke-width: 3px;
  stroke-linejoin: round;
  pointer-events: none;
}
/* 选中节点底部的小圆点：从这里拖出新的关系线 */
.mm-link-dot {
  fill: var(--dsw-alias-bg-base, #fff);
  stroke: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke-width: 2;
  cursor: crosshair;
  pointer-events: all;
}
.mm-link-dot:hover {
  fill: var(--dsw-alias-state-business-primary, #4a7dff);
}

/* 撑出滚动范围的虚拟留白层：只占位、不显示 */
.mm-canvas-space {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}
.mm-zoom {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 6px;
  padding-left: 8px;
  border-left: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .1));
}
.mm-zoom-btn {
  min-width: 26px;
  padding: 0 6px;
  font-size: 14px;
  line-height: 1;
}
.mm-zoom-value {
  min-width: 48px;
  height: 26px;
  padding: 0 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.mm-zoom-value:hover {
  background: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.mm-zoom-value:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: 1px;
}

/* ── 节点属性面板 ─────────────────────────────────────── */
/*
 * 固定在画布下方的一条栏。放底部而不是浮窗：
 * 调颜色需要反复试，面板必须稳定可见、不遮住正在看的节点。
 */
/*
 * 属性抽屉：占据右侧一整列，纵向排列。
 *
 * 从"画布下方横条"改过来：横条挤占画布高度，导图一深就得上下滚；
 * 抽屉只占宽度，画布高度不变。
 */
.mm-style {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #fff);
  padding: 10px 12px 8px;
  overflow: auto;
}
.mm-style-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
  /*
   * 抽屉在右列内部，底部的「恢复默认」不再贴着屏幕右下角，
   * 也就不会再被宿主的桌面宠物浮层盖住（横条时期曾踩过这个坑）。
   */
}
.mm-style-title {
  font-size: 12.5px;
  font-weight: 600;
  flex: none;
}
.mm-style-target {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  max-width: 28ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, .12));
}
.mm-style-scope {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary, #5a5a5a);
}
.mm-style-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.mm-style-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
}
.mm-style-label {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  flex: none;
  min-width: 28px;
}
.mm-style-options {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
/* 色块 / 档位按钮：小、密、选中时描一圈 */
.mm-style-chip {
  min-width: 26px;
  height: 24px;
  padding: 0 7px;
  border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .14));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: border-color .1s ease, box-shadow .1s ease;
  white-space: nowrap;
}
.mm-style-chip:hover {
  border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, .3));
}
.mm-style-chip[data-active="true"] {
  border-color: var(--dsw-alias-state-business-primary, #4a7dff);
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4a7dff);
}
.mm-style-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: 1px;
}
.mm-style-hint {
  margin-top: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}

/* ── 图片大图查看（灯箱） ─────────────────────────────── */
/*
 * 挂到 document.body 上（见 Lightbox.tsx 的说明），层级要压过宿主的一切
 * 浮层：番茄钟的提醒卡片用的是 2147483000，这里取一个比它更高但仍是
 * 合法 32 位整数的值，避免两者打架。
 */
.mm-lightbox {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, .72);
  backdrop-filter: blur(2px);
  animation: mm-lightbox-in .14s ease;
}
@keyframes mm-lightbox-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.mm-lightbox-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(20, 20, 24, .72);
  color: #fff;
}
.mm-lightbox-caption {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 46vw;
}
.mm-lightbox-spacer { flex: 1; }
.mm-lightbox-bar .mm-btn {
  /* 深色背景上必须换成浅色，否则按钮文字与背景糊在一起 */
  color: #fff;
  border-color: rgba(255, 255, 255, .28);
  background: rgba(255, 255, 255, .08);
}
.mm-lightbox-bar .mm-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, .18);
}
.mm-lightbox-scale {
  font-size: 12px;
  min-width: 42px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, .82);
}
.mm-lightbox-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow: auto;
}
.mm-lightbox-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, .5);
  transition: transform .12s ease;
  cursor: zoom-out;
}
.mm-lightbox-loading,
.mm-lightbox-missing {
  color: rgba(255, 255, 255, .78);
  font-size: 13px;
  padding: 24px;
}
.mm-lightbox-missing { color: #ffb4a8; }
.mm-lightbox-hint {
  flex: none;
  text-align: center;
  padding: 0 14px 14px;
  font-size: 11.5px;
  color: rgba(255, 255, 255, .58);
}

/* ── 提示条 ───────────────────────────────────────────── */
.mm-toast {
  position: absolute;
  left: 50%;
  bottom: 16px;
  translate: -50% 0;
  z-index: 8;
  max-width: calc(100% - 32px);
  padding: 7px 13px;
  border-radius: 999px;
  background: var(--dsw-alias-toast-bg, rgba(28,28,32,.94));
  color: var(--dsw-alias-toast-label, #fff);
  font-size: 12.5px;
  box-shadow: 0 6px 22px rgba(0,0,0,.18);
  pointer-events: none;
  animation: mm-toast-in .16s ease;
}
.mm-toast[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #c0392b); }
@keyframes mm-toast-in {
  from { opacity: 0; translate: -50% 6px; }
  to { opacity: 1; translate: -50% 0; }
}

/* ── 滚动条（跟宿主一致） ─────────────────────────────── */
.mm-list::-webkit-scrollbar,
.mm-canvas-wrap::-webkit-scrollbar,
.mm-md-text::-webkit-scrollbar,
.mm-md-preview::-webkit-scrollbar { width: 8px; height: 8px; }
.mm-list::-webkit-scrollbar-thumb,
.mm-canvas-wrap::-webkit-scrollbar-thumb,
.mm-md-text::-webkit-scrollbar-thumb,
.mm-md-preview::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(0,0,0,.18));
  border-radius: 4px;
}

/* ── 减少动效 ─────────────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  .mm-btn, .mm-node, .mm-link, .mm-fold { transition: none; }
  .mm-toast { animation: none; }
}

/* ── 框选 ─────────────────────────────────────────────── */
/*
 * 虚线框。用 outline 而不是 border：border 会占布局尺寸，
 * 让框比实际选区小一圈（1px 边框 + content-box）。
 * pointer-events: none 保证框本身不拦截指针事件。
 */
.mm-marquee {
  position: absolute;
  z-index: 1;
  pointer-events: none;
  border: 1px dashed var(--dsw-alias-state-business-primary, #4a7dff);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 10%, transparent);
  border-radius: 2px;
}
/* 多选中的节点：用较淡的描边区分"主选中"与"一起选中" */
.mm-node[data-multi="true"] {
  border-color: var(--dsw-alias-state-business-primary, #4a7dff);
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary, #4a7dff);
}

/* ── 保存状态 ─────────────────────────────────────────── */
/*
 * 一直可见的小状态灯。用颜色 + 文字双重编码：只靠颜色的话，
 * 色弱用户分辨不出「已保存」和「保存失败」。
 */
.mm-save-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.mm-save-state:hover {
  background: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.mm-save-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
.mm-save-state[data-state="saved"] {
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.mm-save-state[data-state="saved"] .mm-save-dot {
  background: var(--dsw-alias-state-success-primary, #2ea043);
}
.mm-save-state[data-state="pending"] .mm-save-dot {
  background: var(--dsw-alias-state-warn-label, #b8791a);
}
.mm-save-state[data-state="saving"] .mm-save-dot {
  background: var(--dsw-alias-state-business-primary, #4a7dff);
  animation: mm-pulse 1s ease-in-out infinite;
}
.mm-save-state[data-state="error"] {
  color: var(--dsw-alias-state-error-label, #c62828);
  border-color: var(--dsw-alias-state-error-label, #c62828);
}
.mm-save-state[data-state="error"] .mm-save-dot {
  background: var(--dsw-alias-state-error-label, #c62828);
}
@keyframes mm-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
}

/* ── 长文本悬停提示 ───────────────────────────────────── */
/*
 * 自己画的浮层（不用原生 title）：延迟短、样式可控、长文本能换行。
 * 挂 body 上，z-index 低于灯箱但高于画布与抽屉。
 */
.mm-tooltip {
  position: fixed;
  z-index: 2147483400;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #2b3038);
  color: var(--dsw-alias-label-primary, #f5f7fa);
  border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, .2));
  box-shadow: 0 4px 14px rgba(0, 0, 0, .18);
  font-size: 12.5px;
  line-height: 1.5;
  /* 长文本换行而不是撑成一条横线 */
  white-space: pre-wrap;
  word-break: break-word;
  pointer-events: none;
}

/* ── 连线：命中区 / 文字 / 拖动虚影 ───────────────────── */
/*
 * 线的视觉宽度只有 1.5px，直接点几乎点不中。叠一条透明的粗线专门接指针，
 * 视觉不变但可点范围大了十倍。
 */
.mm-link-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  pointer-events: stroke;
  cursor: grab;
}
.mm-link-hit:hover + .mm-link,
.mm-link-hit:active {
  cursor: grabbing;
}
/* 拖动连线时的虚影：表示"这条线正在被拖到某处" */
.mm-link-ghost {
  fill: none;
  stroke: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke-width: 2;
  stroke-dasharray: 5 4;
  pointer-events: none;
}
/* 连线上的文字 */
.mm-edge-label {
  position: absolute;
  transform: translate(-50%, -50%);
  /*
   * 标签不吃指针事件。
   *
   * 它压在连线上，如果吃事件，点标签就点不到下面的线了；
   * 而现在"点线 = 选中并编辑"，让事件穿透过去正好。
   * 也顺便避免了标签挡住节点上的点击。
   */
  pointer-events: none;
  /* 节点间距只有 54px，标签必然比间隙宽，所以画在节点**之上**才不会被盖住 */
  z-index: 4;
  max-width: 150px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, #fff);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .1));
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  font-size: 11.5px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
}

/* 连线文字编辑框 */
.mm-edge-input {
  position: absolute;
  transform: translate(-50%, -50%);
  width: 168px;
  height: 26px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1.5px solid var(--dsw-alias-state-business-primary, #4a7dff);
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font: inherit;
  font-size: 12px;
  outline: none;
  z-index: 9;
}

/* ── 节点图片：悬停操作 ───────────────────────────────── */
/*
 * 图片外面包一层，用来定位操作条。
 * 原来 img 是直接子元素，加操作条需要一个定位容器。
 */
/*
 * 注意：这里必须用 .mm-node .xxx 这种更高优先级。
 * 上面有一条针对 .mm-node 下所有 span 的宽泛规则（width: 100%、overflow: hidden），
 * 它同样命中图片容器和操作条——直接把操作条拉成整行宽、按钮挤到左边，
 * 还会把溢出的按钮裁掉。权重 0,2,0 > 0,1,1，能压过去。
 */
.mm-node .mm-node-img-box {
  position: relative;
  display: inline-block;
  width: auto;
  overflow: visible;
  flex: none;
  line-height: 0;
  text-align: left;
}
.mm-node-img-box > img {
  display: block;
}
/* 操作条：默认透明不可见，hover 才显现 */
.mm-node .mm-img-actions {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  overflow: visible;
  text-align: left;
  /* 不写这两行会被拉成整行宽，按钮就跑到左边去了 */
  width: fit-content;
  justify-content: flex-end;
  gap: 2px;
  opacity: 0;
  transition: opacity .12s ease;
  pointer-events: none;
}
.mm-node-img-box:hover .mm-img-actions {
  opacity: 1;
  pointer-events: auto;
}
.mm-img-btn {
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: rgba(20, 22, 26, .72);
  color: #fff;
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  cursor: pointer;
}
.mm-img-btn:hover {
  background: rgba(20, 22, 26, .92);
}
.mm-img-btn[data-danger="true"]:hover {
  background: var(--dsw-alias-state-error-label, #c62828);
}
.mm-img-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4a7dff);
  outline-offset: 1px;
}

/* 属性面板：标识按钮 */
.mm-mark-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.mm-mark-chip[data-active="true"] {
  border-color: var(--dsw-alias-state-business-primary, #4a7dff);
  background: var(--dsw-alias-bg-layer-2, rgba(74, 125, 255, .12));
}

/* 属性面板：标签旁的"默认 / 当前 N"小标记 */
.mm-style-default,
.mm-style-current {
  margin-left: 4px;
  font-style: normal;
  font-size: 10px;
  padding: 0 3px;
  border-radius: 3px;
  vertical-align: middle;
}
.mm-style-default {
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, .05));
}
.mm-style-current {
  color: var(--dsw-alias-state-business-label, #4a7dff);
  background: var(--dsw-alias-bg-layer-2, rgba(74, 125, 255, .12));
}

/* ── 节点标识（⭐ 重点 等） ───────────────────────────── */
/*
 * 用 .mm-node .mm-marks 提高权重：上面有一条针对 .mm-node 下所有 span 的
 * 宽泛规则（width: 100%、overflow: hidden、text-overflow: ellipsis），
 * 不压过去的话图标会被拉成整行宽、还会被裁掉。
 */
.mm-node .mm-marks {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  width: auto;
  flex: none;
  overflow: visible;
  text-overflow: clip;
  /* emoji 的基线通常偏低，往下压一点点视觉上才和文字居中 */
  line-height: 1;
  transform: translateY(1px);
}
.mm-node .mm-mark {
  width: auto;
  flex: none;
  overflow: visible;
  font-size: 1.05em;
  line-height: 1;
}

/* 被点中的连线：加粗 + 变色，让"现在操作的是这条边"一眼可见 */
.mm-link[data-selected="true"] {
  stroke: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke-width: 2.5;
}

/* ── 连线的两端手柄与删除按钮 ─────────────────────────── */
/*
 * 连线本体只有 1.5px，靠"精确点在线上再拖"在密集的图里几乎做不到。
 * 手柄做成 11px 的圆点（r=5 + 描边），好点得多，
 * 而且"两端都能拖"这件事本身变得可见。
 */
.mm-edge-handle {
  fill: var(--dsw-alias-bg-base, #fff);
  stroke: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke-width: 2;
  cursor: grab;
  pointer-events: all;
}
.mm-edge-handle:hover {
  fill: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke: var(--dsw-alias-bg-base, #fff);
}
.mm-edge-handle:active {
  cursor: grabbing;
}
/* 中点删除按钮 */
.mm-edge-remove {
  cursor: pointer;
  pointer-events: all;
}
.mm-edge-remove circle {
  fill: var(--dsw-alias-bg-base, #fff);
  stroke: var(--dsw-alias-border-l1, rgba(0, 0, 0, .18));
  stroke-width: 1;
}
.mm-edge-remove path {
  stroke: var(--dsw-alias-label-secondary, #5a5a5a);
  stroke-width: 1.6;
  stroke-linecap: round;
  fill: none;
  pointer-events: none;
}
.mm-edge-remove:hover circle {
  fill: var(--dsw-alias-state-error-label, #c62828);
  stroke: var(--dsw-alias-state-error-label, #c62828);
}
.mm-edge-remove:hover path {
  stroke: #fff;
}

/* ── 自由连线（关系线） ─────────────────────────────── */
/*
 * 和父子连线用不同线型区分：实线 = 层级结构，虚线 = 我另外标的关联。
 */
.mm-free-link {
  stroke-dasharray: 6 4;
  opacity: .85;
}
.mm-free-link[data-selected="true"] {
  stroke: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke-width: 2.5;
  opacity: 1;
}
.mm-free-link-label {
  font-size: 11.5px;
  fill: var(--dsw-alias-label-secondary, #5a5a5a);
  paint-order: stroke;
  stroke: var(--dsw-alias-bg-base, #fff);
  stroke-width: 3px;
  stroke-linejoin: round;
  pointer-events: none;
}
/* 选中节点底部的小圆点：从这里拖出新的关系线 */
.mm-link-dot {
  fill: var(--dsw-alias-bg-base, #fff);
  stroke: var(--dsw-alias-state-business-primary, #4a7dff);
  stroke-width: 2;
  cursor: crosshair;
  pointer-events: all;
}
.mm-link-dot:hover {
  fill: var(--dsw-alias-state-business-primary, #4a7dff);
}

/*
 * 画布滚动条：常驻可见。
 *
 * macOS 默认是"悬浮式滚动条"——不滚动时完全隐藏，用户会以为没有滚动条
 * （实际反馈就是这样）。显式给 ::-webkit-scrollbar 写样式后，
 * Chrome / Safari 会改成常驻显示；Firefox 用 scrollbar-width/color。
 */

/* ── 搜索 ─────────────────────────────────────────────── */
.mm-search {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px 0 8px;
  height: 30px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 7px;
  background: var(--dsw-alias-bg-base, #fff);
}
.mm-search-input {
  width: 190px;
  height: 24px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font: inherit;
  font-size: 12.5px;
}
.mm-search-count {
  min-width: 34px;
  text-align: center;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
/*
 * 匹配高亮。
 *
 * 用 box-shadow 而不是 border：border 会改变盒子尺寸，把布局挤动一格。
 */
.mm-node[data-match="true"] {
  box-shadow: 0 0 0 2px rgba(74, 125, 255, .45);
}
.mm-node[data-match-current="true"] {
  box-shadow: 0 0 0 3px var(--dsw-alias-state-business-primary, #4a7dff);
}

/* 线型：虚线用 dasharray，实线保持默认 */
.mm-link[data-style="dashed"] {
  stroke-dasharray: 7 5;
}
.mm-link-hit[data-style="dashed"] {
  stroke-dasharray: 7 5;
}

/* ── 连线线型切换 ─────────────────────────────────────── */
.mm-edge-style {
  cursor: pointer;
}
.mm-edge-style-bg {
  fill: var(--dsw-alias-bg-base, #fff);
  stroke: var(--dsw-alias-border-l2, rgba(0, 0, 0, .2));
  stroke-width: 1;
}
.mm-edge-style-opt {
  font-size: 11px;
  fill: var(--dsw-alias-label-secondary, #666);
  text-anchor: middle;
  dominant-baseline: middle;
  user-select: none;
}
.mm-edge-style-opt[data-active="true"] {
  fill: var(--dsw-alias-state-business-primary, #4a7dff);
  font-weight: 600;
}

`;
