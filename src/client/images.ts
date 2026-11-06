/**
 * dsh-mindmap — 图片通道（Client 半区）。
 *
 * 浏览器侧要做两件事：把 File 变成字节交给 Host 存盘；把 Host 存着的
 * 图片取回来显示。
 *
 * 显示用 **object URL** 而不是 base64 data URI：
 *   data URI 每张图要复制一份 base64 字符串进 DOM，几十张图时内存翻倍、
 *   切换文档时还回收不掉。object URL 只是一个指向 Blob 的字符串，
 *   卸载时 revoke 即可释放。
 */

import type { NodeImage } from "../core/tree.ts";
import { callHost } from "./store.ts";

/** 生成一个合法的图片 id（Host 会用白名单校验，这里负责生成合规值）。 */
export function newImageId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return "img-" + Date.now().toString(36) + "-" + rand;
}

/** File → base64（不带 data: 前缀）。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("读取结果不是字符串"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/** 图片 id → object URL 的缓存。同一张图多处引用只取一次。 */
const urlCache = new Map<string, string>();
/** 正在取的那些：并发渲染同一张图时不要发两次请求。 */
const inflight = new Map<string, Promise<string | undefined>>();

/**
 * 取一张图片的 object URL。
 * @param image - 图片元数据（id 与 type 决定请求）。
 * @returns 可用于 `<img src>` 的 URL；取不到返回 undefined。
 */
export async function imageUrl(image: { id: string; type: string }): Promise<string | undefined> {
  const key = image.id;
  const cached = urlCache.get(key);
  if (cached !== undefined) return cached;

  const running = inflight.get(key);
  if (running !== undefined) return running;

  const task = (async () => {
    try {
      const payload = await callHost<{ data: string; type: string }>("assets.get", {
        id: image.id,
        type: image.type,
      });
      const binary = atob(payload.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: payload.type });
      const url = URL.createObjectURL(blob);
      urlCache.set(key, url);
      return url;
    } catch {
      return undefined;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/**
 * 上传一张图片到 Host。
 * @param file - 选中的文件。
 * @returns 存好的元数据；失败抛出带可读原因的 Error。
 */
export async function uploadImage(file: File): Promise<NodeImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("只能添加图片文件");
  }
  const data = await fileToBase64(file);
  const payload = await callHost<{ image: NodeImage }>("assets.put", {
    id: newImageId(),
    type: file.type,
    data,
  });
  // Host 以魔数为准可能改写了 type，以它返回的为准
  return { ...payload.image, name: file.name || payload.image.name };
}

/** 释放所有 object URL（插件卸载时调用，避免 Blob 泄漏）。 */
export function releaseAllImageUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
  inflight.clear();
}
