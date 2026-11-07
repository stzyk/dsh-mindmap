/**
 * dsh-mindmap — AI 助手抽屉（右侧）。
 *
 * 这一版只做**能看、能输入、能记住对话**的骨架，真正的模型调用在下一步接。
 * 先把 UI 和状态跑通，再接工具，避免一次改太多东西查不出问题。
 */

import * as React from "react";

/** 一条对话消息。 */
export interface AiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** 助手消息是否还在生成。 */
  pending?: boolean;
  /** 这条消息产生的改动预览（大改动才需要确认）。 */
  preview?: {
    /** 一句话说明将要做什么。 */
    summary: string;
    /** 用户点「应用」时执行的副作用。 */
    apply: () => void;
  };
}

export interface AiPanelProps {
  /** 当前打开的导图标题（没打开时为 null）。 */
  docTitle: string | null;
  messages: AiMessage[];
  /** 输入框内容。 */
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  onClear: () => void;
  onClose: () => void;
  /** 正在等待模型回复。 */
  busy: boolean;
}

export function AiPanel({
  docTitle,
  messages,
  draft,
  onDraftChange,
  onSend,
  onClear,
  onClose,
  busy,
}: AiPanelProps): React.ReactElement {
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // 有新消息就滚到底
  React.useEffect(() => {
    const el = listRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  return (
    <div className="mm-ai" data-mm-ai="true">
      <div className="mm-ai-head">
        <span className="mm-ai-title">导图助手</span>
        <span className="mm-ai-target" title={docTitle ?? "还没有打开导图"}>
          {docTitle ?? "未打开导图"}
        </span>
        <button type="button" className="mm-btn" data-mm-action="ai-clear" onClick={onClear} title="清空对话">
          清空
        </button>
        <button type="button" className="mm-btn" data-mm-action="ai-close" onClick={onClose} title="关闭">
          ×
        </button>
      </div>

      <div className="mm-ai-list" ref={listRef} data-mm-ai-list="true">
        {messages.length === 0 ? (
          <div className="mm-ai-empty">
            <p>说说你想怎么改这张图，比如：</p>
            <ul>
              <li>把「密炼法」下面的节点合并成一个</li>
              <li>总结一下这张图的主要结构</li>
              <li>根据这份提纲生成一张新导图</li>
            </ul>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="mm-ai-msg" data-role={message.role}>
              <div className="mm-ai-bubble">
                {message.pending === true ? <span className="mm-ai-dots">…</span> : message.text}
              </div>
              {message.preview !== undefined ? (
                <div className="mm-ai-preview" data-mm-ai-preview="true">
                  <div className="mm-ai-preview-text">{message.preview.summary}</div>
                  <div className="mm-ai-preview-actions">
                    <button
                      type="button"
                      className="mm-btn"
                      data-mm-action="ai-apply"
                      onClick={() => message.preview?.apply()}
                    >
                      应用
                    </button>
                    <button type="button" className="mm-btn" data-mm-action="ai-discard">
                      忽略
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))
        )}
        {busy ? (
          <div className="mm-ai-msg" data-role="assistant">
            <div className="mm-ai-bubble mm-ai-dots">正在思考…</div>
          </div>
        ) : null}
      </div>

      <div className="mm-ai-foot">
        <textarea
          className="mm-ai-input"
          data-mm-ai-input="true"
          value={draft}
          rows={3}
          placeholder="描述你要生成 / 修改 / 总结的内容（Enter 发送，Shift+Enter 换行）"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!busy && draft.trim().length > 0) onSend();
            }
          }}
        />
        <button
          type="button"
          className="mm-btn mm-ai-send"
          data-mm-action="ai-send"
          disabled={busy || draft.trim().length === 0}
          onClick={onSend}
        >
          发送
        </button>
      </div>
    </div>
  );
}
