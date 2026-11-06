/**
 * dsh-mindmap — 图片大图查看（灯箱）。
 *
 * 为什么必须 portal 到 document.body：
 *   画布是 `overflow: auto` 的滚动容器，任何 `position: fixed` 的子元素
 *   在里面都可能被裁剪或跟随滚动。灯箱要盖住整个面板，只能挂到 body 上
 *   —— 这也是插件里唯一一处敢动 body 的地方，卸载时必须收干净。
 *
 * 交互：
 *   - 双击节点里的缩略图打开
 *   - 点背景 / 点关闭按钮 / 按 Esc 关闭
 *   - 打开时锁定 body 滚动，关闭时恢复原值（不是无脑设成 ''）
 */

import * as React from "react";
import * as ReactDOM from "react-dom";

import { imageUrl } from "./images.ts";

/** 灯箱要展示的图片。 */
export interface LightboxTarget {
  id: string;
  type: string;
  caption?: string;
  name?: string;
}

interface LightboxProps {
  image: LightboxTarget;
  /** 关闭回调。 */
  onClose: () => void;
}

/**
 * 灯箱本体。
 *
 * 大图也是按需从 Host 取的（不做预加载）：用户可能只双击其中一张，
 * 没必要为了"可能要看"把几十张原图全拉下来。
 */
export function Lightbox({ image, onClose }: LightboxProps): React.ReactElement {
  const [url, setUrl] = React.useState<string | undefined>(undefined);
  const [failed, setFailed] = React.useState(false);
  const [scale, setScale] = React.useState(1);

  React.useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setUrl(undefined);
    setScale(1);
    void imageUrl(image).then((resolved) => {
      if (cancelled) return;
      if (resolved === undefined) setFailed(true);
      else setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [image.id, image.type]);

  // Esc 关闭。挂在 document 上而不是元素上：焦点可能在任意位置。
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // 打开期间锁滚动。记录原值，关闭时还原——直接设 '' 会把宿主原本的
  // overflow 设置一起抹掉。
  React.useEffect(() => {
    const body = document.body;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previous;
    };
  }, []);

  const label = image.caption ?? image.name ?? "图片";

  return ReactDOM.createPortal(
    <div
      className="mm-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={"查看大图：" + label}
      data-mm-panel="lightbox"
      onClick={onClose}
    >
      <div className="mm-lightbox-bar" onClick={(event) => event.stopPropagation()}>
        <span className="mm-lightbox-caption">{label}</span>
        <span className="mm-lightbox-spacer" />
        {/* 缩放：手机上大图往往超出视口，需要能缩小看全貌 */}
        <button
          type="button"
          className="mm-btn"
          data-mm-action="zoom-out"
          onClick={() => setScale((value) => Math.max(0.25, Number((value - 0.25).toFixed(2))))}
          title="缩小"
        >
          −
        </button>
        <span className="mm-lightbox-scale">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className="mm-btn"
          data-mm-action="zoom-in"
          onClick={() => setScale((value) => Math.min(4, Number((value + 0.25).toFixed(2))))}
          title="放大"
        >
          +
        </button>
        <button
          type="button"
          className="mm-btn"
          data-mm-action="zoom-reset"
          onClick={() => setScale(1)}
          title="恢复原始大小"
        >
          1:1
        </button>
        <button
          type="button"
          className="mm-btn"
          data-mm-action="lightbox-close"
          onClick={onClose}
          title="关闭（Esc）"
        >
          关闭
        </button>
      </div>

      {/*
       * 舞台本身就是"背景"：它铺满整个灯箱，点它应该关闭。
       *
       * 之前这里写的是 stopPropagation()，本意是"别让舞台吃掉点击"，
       * 结果把关闭路径整个堵死了 —— 空白区域全是舞台，点哪儿都关不掉，
       * 只有 Esc 和按钮能用。现在的做法：舞台点击 = 关闭；点图片时
       * 由图片自己 stopPropagation，所以看图不会误关。
       */}
      <div className="mm-lightbox-stage" onClick={onClose}>
        {failed ? (
          <div className="mm-lightbox-missing">图片文件找不到了（可能已被手动删除）</div>
        ) : url === undefined ? (
          <div className="mm-lightbox-loading">正在加载…</div>
        ) : (
          <img
            className="mm-lightbox-img"
            src={url}
            alt={image.caption ?? ""}
            style={{ transform: scale === 1 ? undefined : "scale(" + String(scale) + ")" }}
            /*
             * 单击图片不关闭（要在放大状态下看细节），所以阻止冒泡；
             * 双击图片才关闭，符合"再点一下收起"的直觉。
             */
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={onClose}
            draggable={false}
          />
        )}
      </div>

      <div className="mm-lightbox-hint">点背景或按 Esc 关闭 · 双击图片也能关</div>
    </div>,
    document.body,
  );
}
