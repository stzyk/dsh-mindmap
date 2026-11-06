/**
 * dsh-mindmap — 右侧 Markdown 栏（可编辑）。
 *
 * 定位变了：它不再是"和画布二选一的一个视图"，而是画布右边常驻的一栏，
 * 可以随时收起。两边都能改：
 *   - 画布上改 → 这里实时跟着变（tree → markdown）；
 *   - 这里改 → 点「应用修改」时合并回树（markdown → tree）。
 *
 * 为什么不做实时同步：中文输入法一个词要按好几次键，边打边解析会让
 * 半截语法（比如刚敲一个 `#`）频繁重建树，光标乱跳、历史栈爆炸。
 * 折中：显式的「应用修改」按钮 + 失焦不自动应用（用户可能只是去点
 * 画布看一眼，贸然回写会打断节奏）。
 *
 * 回写走 `mergeTree` 而不是整棵重建：节点上的图片、拖动位置、折叠状态
 * 要保留。这条是硬要求——用户改一句文字不该把配图丢掉。
 */

import * as React from "react";

import { safeFileName, toMarkdown, toMarkdownForest, type MarkdownMode } from "../core/markdown.ts";
import { parseMarkdown } from "../core/parse.ts";
import type { MindmapStore, ViewState } from "./store.ts";

interface MarkdownPanelProps {
  store: MindmapStore;
  state: ViewState;
}

/** 极简 Markdown 预览：只认标题 / 列表 / 引用，够核对层级就行。 */
function renderPreview(markdown: string): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  let listBuffer: Array<{ depth: number; text: string }> = [];
  let quoteBuffer: string[] = [];
  let keySeq = 0;

  const flushList = (): void => {
    if (listBuffer.length === 0) return;
    const render = (items: Array<{ depth: number; text: string }>, depth: number): React.ReactNode => {
      const nodes: React.ReactNode[] = [];
      let index = 0;
      while (index < items.length) {
        const item = items[index];
        if (item.depth > depth) {
          index += 1;
          continue;
        }
        const children: Array<{ depth: number; text: string }> = [];
        let cursor = index + 1;
        while (cursor < items.length && items[cursor].depth > depth) {
          children.push(items[cursor]);
          cursor += 1;
        }
        nodes.push(
          <li key={"li-" + String(keySeq++)}>
            {item.text}
            {children.length > 0 ? render(children, children[0].depth) : null}
          </li>,
        );
        index = cursor;
      }
      return <ul>{nodes}</ul>;
    };
    blocks.push(
      <React.Fragment key={"ul-" + String(keySeq++)}>{render(listBuffer, listBuffer[0].depth)}</React.Fragment>,
    );
    listBuffer = [];
  };

  const flushQuote = (): void => {
    if (quoteBuffer.length === 0) return;
    blocks.push(<blockquote key={"q-" + String(keySeq++)}>{quoteBuffer.join("\n")}</blockquote>);
    quoteBuffer = [];
  };

  for (const raw of markdown.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    const listItem = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    const quote = /^>\s?(.*)$/.exec(raw);

    if (heading !== null) {
      flushList();
      flushQuote();
      const Tag = ("h" + String(heading[1].length)) as "h1";
      blocks.push(React.createElement(Tag, { key: "h-" + String(keySeq++) }, heading[2]));
    } else if (listItem !== null) {
      flushQuote();
      listBuffer.push({ depth: Math.floor(listItem[1].length / 2), text: listItem[2] });
    } else if (quote !== null) {
      flushList();
      quoteBuffer.push(quote[1]);
    } else if (raw.trim().length === 0) {
      flushList();
      flushQuote();
    }
  }
  flushList();
  flushQuote();
  return blocks;
}

/** 右侧 Markdown 栏。 */
export function MarkdownPanel({ store, state }: MarkdownPanelProps): React.ReactElement {
  const doc = state.doc;
  const [mode, setMode] = React.useState<MarkdownMode>("headings");
  const [includeNotes, setIncludeNotes] = React.useState(true);
  const [includeTitle, setIncludeTitle] = React.useState(false);
  const [showPreview, setShowPreview] = React.useState(false);
  /**
   * 内嵌图片：把字节编进 .md，单文件可分享。
   * 只在需要时拉字节，避免每次打开侧栏都把图片传一遍。
   */
  const [inlineImages, setInlineImages] = React.useState(false);
  const [imageData, setImageData] = React.useState<Record<string, { data: string; type: string }>>({});

  /**
   * 编辑中的草稿。
   *
   * 不直接把 textarea 绑到"从树生成的内容"上：用户输入时树还没变，
   * 若 value 每次都由树算出来，每敲一个字光标都会被顶回末尾。
   *
   * `draft === null` 表示"正在跟随树"；一旦编辑就变成非 null，
   * 直到应用或放弃。
   */
  const [draft, setDraft] = React.useState<string | null>(null);

  /** 由当前树生成的 markdown（只读展示用）。 */
  const generated = React.useMemo(() => {
    if (doc === null) return "";
    const options = {
      mode,
      includeNotes,
      includeTitle,
      title: doc.title,
      images: (inlineImages ? "inline" : "path") as "inline" | "path",
      resolveImage: (image: { id: string }) => imageData[image.id],
    };
    // 多主题：容器根不导出，逐个主题各成一片
    if (doc.multiTheme === true) return toMarkdownForest(doc.root.children, options);
    return toMarkdown(doc.root, options);
  }, [doc, mode, includeNotes, includeTitle, inlineImages, imageData]);

  // 切换文档时丢弃草稿
  React.useEffect(() => {
    setDraft(null);
  }, [doc?.id]);

  /*
   * 树被外部改动时（用户去画布上操作了），丢掉未提交的草稿，跟随树。
   *
   * 不这么做的话：用户在侧栏敲了几个字但没应用，转头去画布加了个节点，
   * 侧栏还显示着那份旧草稿 —— 看起来"画布的改动没同步过来"。
   *
   * 取舍：画布是主视图，它的最新状态优先于未提交的草稿。
   * 但**不能静默丢弃**：用户敲的字是他以为保存了的东西，得明确告诉他。
   */
  const rootRef = React.useRef(doc?.root);
  React.useEffect(() => {
    if (doc === null) return;
    if (doc.root === rootRef.current) return;
    rootRef.current = doc.root;
    setDraft((current) => {
      if (current === null) return null;
      store.toast("画布已更新，未应用的 Markdown 修改已丢弃");
      return null;
    });
  }, [doc?.root, doc, store]);

  // 勾选内嵌后才去拉字节；取消勾选立即释放（几十张图的 base64 很占内存）
  React.useEffect(() => {
    if (!inlineImages) {
      setImageData({});
      return;
    }
    let cancelled = false;
    void store.imageData().then((data) => {
      if (cancelled) return;
      setImageData(data);
      setDraft(null);
    });
    return () => {
      cancelled = true;
    };
  }, [inlineImages, store]);

  const hasImages = React.useMemo(() => {
    if (doc === null) return false;
    let found = false;
    const walk = (node: { images?: unknown[]; children: unknown[] }): void => {
      if ((node.images?.length ?? 0) > 0) found = true;
      for (const child of node.children) walk(child as typeof node);
    };
    walk(doc.root);
    return found;
  }, [doc]);

  const text = draft ?? generated;
  const dirty = draft !== null && draft !== generated;

  /** 应用草稿：解析 → 合并回树。 */
  const apply = React.useCallback(() => {
    if (doc === null || draft === null) return;
    /*
     * 多主题暂不支持反向同步。
     *
     * 解析与合并（parse.ts / mergeTree）都是以"单根"为前提写的，
     * 多主题要让它们变成森林合并。没做之前**明确拒绝并说明原因**，
     * 而不是让它悄悄按单根合并、把几个主题挤成一棵。
     */
    if (doc.multiTheme === true) {
      store.toast("多主题导图暂不支持从 Markdown 反向修改", "error");
      return;
    }
    const parsed = parseMarkdown(draft);
    if (parsed.entries.length === 0) {
      store.toast("Markdown 里没有可识别的标题或列表项", "error");
      return;
    }
    const result = store.applyMarkdown(parsed.entries);
    if (result !== undefined) {
      const parts: string[] = [];
      if (result.added > 0) parts.push("新增 " + String(result.added));
      if (result.changed > 0) parts.push("修改 " + String(result.changed));
      if (result.removed > 0) parts.push("删除 " + String(result.removed));
      store.toast(parts.length > 0 ? "已同步到画布：" + parts.join(" / ") : "已同步到画布");
      setDraft(null);
    }
  }, [doc, draft, store]);

  const discard = (): void => {
    setDraft(null);
    store.toast("已放弃修改");
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      store.toast("Markdown 已复制到剪贴板");
    } catch {
      store.toast("浏览器拒绝了剪贴板访问，请在文本框里手动全选复制", "error");
    }
  };

  const download = (): void => {
    if (doc === null) return;
    const fileName = safeFileName(doc.title) + ".md";
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    store.toast("已下载 " + fileName);
  };

  const downloadImages = async (): Promise<void> => {
    try {
      const files = await store.exportImages();
      if (files.length === 0) {
        store.toast("这份导图没有图片", "error");
        return;
      }
      for (const file of files) {
        const binary = atob(file.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: file.type });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      store.toast("已导出 " + String(files.length) + " 张图片");
    } catch (error) {
      store.toast((error as Error).message, "error");
    }
  };


  return (
    <div className="mm-md-panel" data-mm-panel="markdown">
      <div className="mm-md-head">
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Markdown</span>

        <div role="group" aria-label="Markdown 形态" style={{ display: "inline-flex", gap: 4 }}>
          <button
            type="button"
            className="mm-btn"
            data-primary={mode === "headings" ? "true" : undefined}
            onClick={() => {
              setMode("headings");
              setDraft(null);
            }}
            title="每层一个 # 标题"
          >
            标题
          </button>
          <button
            type="button"
            className="mm-btn"
            data-primary={mode === "list" ? "true" : undefined}
            onClick={() => {
              setMode("list");
              setDraft(null);
            }}
            title="嵌套无序列表"
          >
            列表
          </button>
        </div>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={includeNotes}
            onChange={(event) => {
              setIncludeNotes(event.target.checked);
              setDraft(null);
            }}
          />
          备注
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={includeTitle}
            onChange={(event) => {
              setIncludeTitle(event.target.checked);
              setDraft(null);
            }}
          />
          标题
        </label>

        {hasImages ? (
          <label
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}
            title="把图片直接编进 .md，单文件即可分享（图多时文件会变大）"
          >
            <input
              type="checkbox"
              checked={inlineImages}
              onChange={(event) => setInlineImages(event.target.checked)}
              data-mm-action="inline-images"
            />
            内嵌图片
          </label>
        ) : null}

        <div className="mm-grow" />

        <button
          type="button"
          className="mm-btn"
          data-icon="true"
          title="收起 Markdown 栏"
          onClick={() => store.closeMarkdown()}
          data-mm-action="hide-md"
        >
          ›
        </button>
      </div>

      <div className="mm-md-body">
        <textarea
          className="mm-md-text"
          value={text}
          aria-label="Markdown 源码（可直接编辑）"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
        {showPreview ? (
          <div className="mm-md-preview" aria-label="Markdown 预览">
            {renderPreview(text)}
          </div>
        ) : null}
      </div>

      <div className="mm-md-foot">
        {dirty ? (
          <>
            <span className="mm-md-dirty">未同步</span>
            <button type="button" className="mm-btn" data-primary="true" onClick={apply} data-mm-action="apply-md">
              应用修改
            </button>
            <button type="button" className="mm-btn" onClick={discard} data-mm-action="discard-md">
              放弃
            </button>
          </>
        ) : (
          <span className="mm-md-hint">直接编辑这里，改完点「应用修改」同步到画布</span>
        )}
        <div className="mm-grow" />
        <button
          type="button"
          className="mm-btn"
          data-icon="true"
          onClick={() => setShowPreview((value) => !value)}
          title={showPreview ? "隐藏预览" : "显示预览"}
          data-mm-action="toggle-preview"
        >
          {showPreview ? "◧" : "◨"}
        </button>
        {hasImages ? (
          <button type="button" className="mm-btn" onClick={downloadImages} data-mm-action="download-images">
            图片
          </button>
        ) : null}
        <button type="button" className="mm-btn" onClick={download} data-mm-action="download">
          .md
        </button>
        <button type="button" className="mm-btn" onClick={copy} data-mm-action="copy-md">
          复制
        </button>
      </div>
    </div>
  );
}
