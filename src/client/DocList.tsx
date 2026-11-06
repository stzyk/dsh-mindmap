/**
 * dsh-mindmap — 导图列表（Client 半区）。
 *
 * 列表页承担三件事：新建、打开、删除/改名。
 * 搜索是本地过滤（列表已经是全量快照，没必要为几十份文档再开一次 round-trip）。
 */

import * as React from "react";

import type { MindDocSummary } from "../core/tree.ts";
import type { MindmapStore, ViewState } from "./store.ts";

interface DocListProps {
  store: MindmapStore;
  state: ViewState;
}

/** 相对时间：导图列表里"8 分钟前"比一串时间戳有用得多。 */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "刚刚";
  if (diff < hour) return String(Math.floor(diff / minute)) + " 分钟前";
  if (diff < day) return String(Math.floor(diff / hour)) + " 小时前";
  if (diff < 30 * day) return String(Math.floor(diff / day)) + " 天前";
  const date = new Date(timestamp);
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

/** 按标题过滤。 */
export function filterDocs(docs: MindDocSummary[], query: string): MindDocSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return docs;
  return docs.filter((doc) => doc.title.toLowerCase().includes(needle));
}

/** 列表页。 */
export function DocList({ store, state }: DocListProps): React.ReactElement {
  const [title, setTitle] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");

  const visible = filterDocs(state.docs, state.query);

  const create = (): void => {
    void store.create(title);
    setTitle("");
  };

  const commitRename = (id: string): void => {
    const value = renameDraft.trim();
    setRenamingId(null);
    if (value.length === 0) return;
    void store.rename(id, value);
  };

  return (
    <>
      <div className="mm-bar">
        <span className="mm-bar-title">思维导图</span>
        <input
          className="mm-title-input"
          style={{ maxWidth: 200 }}
          placeholder="新导图标题"
          value={title}
          aria-label="新导图标题"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") create();
          }}
        />
        <button type="button" className="mm-btn" data-primary="true" onClick={create} data-mm-action="create">
          新建
        </button>
        <div className="mm-grow" />
        {state.docs.length > 0 ? (
          <input
            className="mm-title-input"
            style={{ maxWidth: 150 }}
            placeholder="搜索"
            value={state.query}
            aria-label="搜索导图"
            onChange={(event) => store.search(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        ) : null}
        <button type="button" className="mm-btn" data-icon="true" title="刷新" onClick={() => void store.refresh()}>
          ↻
        </button>
      </div>

      {state.loading ? (
        <div className="mm-empty">
          <div className="mm-empty-body">正在读取导图…</div>
        </div>
      ) : visible.length === 0 ? (
        <div className="mm-empty" data-mm-empty="true">
          <div className="mm-empty-head">{state.docs.length === 0 ? "还没有任何导图" : "没有匹配的导图"}</div>
          <div className="mm-empty-body">
            {state.docs.length === 0
              ? "在上面填个标题点「新建」，或者在会话里输入 /mindmap new 标题。进到画布里用 Enter 加同级、Tab 缩进，画完点「转 Markdown」导出。"
              : "换个关键词试试。"}
          </div>
          {!state.online ? (
            <div className="mm-empty-body" style={{ color: "var(--dsw-alias-label-error)" }}>
              当前连不上 DSH 存储，下面是浏览器缓存里的只读副本。
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mm-list" role="list">
          {visible.map((doc) => (
            <div
              key={doc.id}
              className="mm-doc"
              role="listitem"
              tabIndex={0}
              onClick={() => void store.open(doc.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void store.open(doc.id);
                }
              }}
            >
              <div className="mm-doc-main">
                {renamingId === doc.id ? (
                  <input
                    className="mm-title-input"
                    style={{ maxWidth: "100%" }}
                    value={renameDraft}
                    autoFocus
                    aria-label="重命名导图"
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onBlur={() => commitRename(doc.id)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") commitRename(doc.id);
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <div className="mm-doc-title">{doc.title}</div>
                )}
                <div className="mm-doc-meta">
                  {String(doc.nodeCount)} 节点 · {relativeTime(doc.updatedAt)}
                </div>
              </div>
              <div className="mm-doc-actions">
                <button
                  type="button"
                  className="mm-btn"
                  data-icon="true"
                  data-ghost="true"
                  title="重命名"
                  aria-label={"重命名 " + doc.title}
                  onClick={(event) => {
                    event.stopPropagation();
                    setRenamingId(doc.id);
                    setRenameDraft(doc.title);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="mm-btn"
                  data-icon="true"
                  data-ghost="true"
                  data-danger="true"
                  title="删除"
                  aria-label={"删除 " + doc.title}
                  data-mm-doc={doc.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (window.confirm("删除「" + doc.title + "」？这个操作没法撤销。")) {
                      void store.remove(doc.id);
                    }
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
