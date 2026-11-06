/**
 * dsh-mindmap — 节点内图片渲染（Client 半区）。
 *
 * 每张图自己负责把 Host 上的字节取回来变成 object URL。为什么不在上层
 * 统一预取：一张导图可能有几十张图，但用户实际只会看当前视口那几张；
 * 按需取 + 缓存，比一次性全拉回来快得多，也不会拖慢首屏。
 */

import * as React from "react";

import { releaseAllImageUrls, imageUrl } from "./images.ts";

interface NodeImageProps {
  image: { id: string; type: string; width: number; height: number; caption?: string };
  /** 点击图片（用于选中节点）。 */
  onActivate?: () => void;
  /** 双击图片（打开大图查看）。 */
  onOpen?: () => void;
  /** 删除这张图片。 */
  onRemove?: () => void;
  /** 替换这张图片（换一个文件）。 */
  onReplace?: () => void;
  /** 修改这张图片的说明文字。 */
  onCaption?: () => void;
}

/** 单张图片。加载失败时显示一个占位，而不是让节点变成空白。 */
export function NodePicture({ image, onActivate, onOpen, onRemove, onReplace, onCaption }: NodeImageProps): React.ReactElement {
  const [url, setUrl] = React.useState<string | undefined>(undefined);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void imageUrl(image).then((resolved) => {
      if (cancelled) return;
      if (resolved === undefined) setFailed(true);
      else setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [image.id, image.type]);

  const common = {
    width: image.width,
    height: image.height,
    className: "mm-node-img",
    draggable: false,
    onPointerDown: (event: React.PointerEvent) => {
      // 图片上按下不启动节点拖动：否则想点图片看一眼会顺手把节点拖走
      event.stopPropagation();
    },
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation();
      onActivate?.();
    },
    /*
     * 双击打开大图查看。
     *
     * 必须 stopPropagation：否则事件冒泡到节点上，会触发节点的
     * onDoubleClick（进入改名），用户想看大图却跳进了编辑框。
     *
     * 单击仍在 onClick 里做"选中节点"，两者不冲突：浏览器会先派发
     * click 再派发 dblclick，选中是幂等的，不影响体验。
     */
    onDoubleClick: (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      onOpen?.();
    },
    title: (image.caption ?? "图片") + "（双击看大图）",
  } as const;

  if (failed) {
    return (
      <span
        className="mm-node-img mm-node-img-missing"
        style={{ width: image.width, height: image.height }}
        title="图片文件找不到了（可能被手动删除）"
      >
        图片丢失
      </span>
    );
  }

  if (url === undefined) {
    // 占位：先把尺寸占住，避免图片到达后整个布局跳动
    return <span className="mm-node-img mm-node-img-loading" style={{ width: image.width, height: image.height }} />;
  }

  return (
    <span className="mm-node-img-box" style={{ width: image.width, height: image.height }}>
      <img {...common} src={url} alt={image.caption ?? ""} />
      {/*
       * 悬停操作条：删除 / 替换 / 改说明。
       *
       * 放在图片右上角、默认透明，hover 才显现——常驻的话每张图上都挂三个
       * 按钮，画布会很吵。pointerdown 必须 stopPropagation，
       * 否则点按钮会顺手把节点拖走。
       */}
      <span className="mm-img-actions" onPointerDown={(event) => event.stopPropagation()}>
        {onCaption !== undefined ? (
          <button
            type="button"
            className="mm-img-btn"
            data-mm-action="img-caption"
            title="修改图片说明"
            aria-label="修改图片说明"
            onClick={(event) => {
              event.stopPropagation();
              onCaption();
            }}
          >
            T
          </button>
        ) : null}
        {onReplace !== undefined ? (
          <button
            type="button"
            className="mm-img-btn"
            data-mm-action="img-replace"
            title="替换这张图片"
            aria-label="替换这张图片"
            onClick={(event) => {
              event.stopPropagation();
              onReplace();
            }}
          >
            ↻
          </button>
        ) : null}
        {onRemove !== undefined ? (
          <button
            type="button"
            className="mm-img-btn"
            data-mm-action="img-remove"
            data-danger="true"
            title="删除这张图片"
            aria-label="删除这张图片"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            ×
          </button>
        ) : null}
      </span>
    </span>
  );
}

/** 节点里的图片行。 */
export function NodePictures({
  images,
  onActivate,
  onOpen,
  onRemove,
  onReplace,
  onCaption,
}: {
  images: NonNullable<import("../core/layout.ts").LayoutNode["images"]>;
  onActivate?: () => void;
  /** 双击某张图时回调（父组件负责打开灯箱）。 */
  onOpen?: (image: { id: string; type: string; caption?: string }) => void;
  /** 删除某张图。 */
  onRemove?: (imageId: string) => void;
  /** 替换某张图。 */
  onReplace?: (imageId: string) => void;
  /** 修改某张图的说明。 */
  onCaption?: (imageId: string, current: string) => void;
}): React.ReactElement {
  return (
    <span className="mm-node-imgs">
      {images.map((image) => (
        <NodePicture
          key={image.id}
          image={image}
          onActivate={onActivate}
          onOpen={() => onOpen?.(image)}
          onRemove={onRemove === undefined ? undefined : () => onRemove(image.id)}
          onReplace={onReplace === undefined ? undefined : () => onReplace(image.id)}
          onCaption={onCaption === undefined ? undefined : () => onCaption(image.id, image.caption ?? "")}
        />
      ))}
    </span>
  );
}

/** 卸载清理：释放所有 object URL。 */
export { releaseAllImageUrls };
