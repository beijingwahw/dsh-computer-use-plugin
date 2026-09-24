// src/imageDelivery.ts
// 图像投递层：把截图送进模型的唯一通道（DSH 0.1.0-rc.6 事件面）。
//
// 为什么存在：旧版的 `llm/pre-request` 注入事件在 rc.6 宿主上已不存在
// （事件面重构）——截图只进滑动窗口、模型只看到文本锚点。rc.6 的正道：
//   1. ctx.attachments.saveImage(bytes) → ImageAttachmentRef（附件服务，
//      内容寻址、跨请求持久）
//   2. 工具结果的 render 输出追加 {type:'image', attachment: ref} 内容块
//      —— 工具结果消息是 user 角色，图像块随请求直达模型
//
// 降级：附件服务缺席（宿主未注入）时返回 null，工具只回文本锚点 ——
// 与旧行为一致，绝不阻塞截图主流程。

interface ImageAttachmentRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef>;
}

let store: AttachmentStoreLike | null = null;

/** index.ts 启动时注入附件服务（缺席 = 宿主未提供，图像投递诚实降级） */
export function setImageDeliveryStore(attachments: unknown): void {
  store = attachments && typeof (attachments as AttachmentStoreLike).saveImage === 'function'
    ? (attachments as AttachmentStoreLike)
    : null;
}

export function imageDeliveryAvailable(): boolean {
  return store !== null;
}

/** 保存 JPEG 截图为附件；失败/缺席返回 null（调用方降级为纯文本锚点） */
export async function saveScreenshotAttachment(jpeg: Buffer, name: string): Promise<ImageAttachmentRef | null> {
  if (!store) return null;
  try {
    return await store.saveImage({
      data: new Uint8Array(jpeg),
      mediaType: 'image/jpeg',
      name,
    });
  } catch {
    return null;
  }
}

/**
 * 工具 render 辅助：解析工具返回的 JSON 值，若携带 image_attachment 则
 * 产出图像内容块（与文本块并列 —— 模型同轮即见文见图）。
 */
export function imageBlockFromValue(value: unknown): Array<Record<string, unknown>> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const ref = parsed?.image_attachment;
    if (ref && typeof ref.attachmentId === 'string') {
      return [{ type: 'image', attachment: ref }];
    }
  } catch { /* 纯文本值 */ }
  return [];
}
