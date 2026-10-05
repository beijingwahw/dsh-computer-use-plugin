// src/approval.shapes.ts
// approval 脱敏契约区（W8-B3 自 approval.ts 拆出 —— 代码逐字保持，零漂移）。
// 隐私铁律的执法面：动作形状的归一化/脱敏/长度桶，外加全簇共用的字符串
// 净化 helper（strOrUndef —— 原定义于队列段，主账本与队列两面消费）。
import { LENGTH_BUCKET_SHORT_MAX, LENGTH_BUCKET_MEDIUM_MAX, LENGTH_BUCKET_LONG_MAX } from './approval.constants';

/** 文本长度桶：type_text 唯一允许携带的文本元数据（粗粒度等价类，绝无内容） */
export function lengthBucket(len: number): string {
  if (!Number.isFinite(len) || len <= 0) return 'empty';
  if (len <= LENGTH_BUCKET_SHORT_MAX) return 'short';
  if (len <= LENGTH_BUCKET_MEDIUM_MAX) return 'medium';
  if (len <= LENGTH_BUCKET_LONG_MAX) return 'long';
  return 'xl';
}

/** 文本输入类工具：示范记录只记工具名与长度桶（隐私铁律 —— 绝不记文本内容） */
const TEXT_INPUT_TOOLS = new Set(['type_text']);

/** 调用方提供的原始动作形状：text 仅用于铸造长度桶，任何情况下不入档 */
export interface RawActionShape {
  tool: string;
  /** 归一化坐标 [0,1]（点击/拖拽类） */
  x?: number;
  y?: number;
  /** 目标描述（type_text 类不记录 —— 最保守脱敏） */
  target_description?: string;
  /** type_text 类的原文：只在此计算长度桶，绝不存储 */
  text?: string;
  /** 直接给定长度桶（无原文时；type_text 专用） */
  text_length_bucket?: string;
}

/** 脱敏后的动作形状（示范事件的载荷类型） */
export interface ActionShape {
  tool: string;
  x?: number;
  y?: number;
  target_description?: string;
  text_length_bucket?: string;
}

/** 归一化坐标：非有限值弃记；[0,1] 钳制；千分位量化（签名匹配的抖动容忍带） */
function normCoord(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
    : undefined;
}

/** 动作形状脱敏（隐私铁律的执法点）：type_text 类只保留工具名+长度桶；
 *  其余工具保留工具名+归一化坐标+目标描述（截 200 字）。
 *  幂等 —— 已脱敏形状再过一次不变（蒸馏面可作二次防线）。 */
export function sanitizeActionShape(raw: RawActionShape): ActionShape {
  if (TEXT_INPUT_TOOLS.has(raw.tool)) {
    return {
      tool: raw.tool,
      text_length_bucket: raw.text_length_bucket ?? lengthBucket(raw.text?.length ?? 0),
    };
  }
  const shape: ActionShape = { tool: raw.tool };
  const x = normCoord(raw.x);
  const y = normCoord(raw.y);
  if (x !== undefined) shape.x = x;
  if (y !== undefined) shape.y = y;
  if (raw.target_description) shape.target_description = raw.target_description.slice(0, 200);
  return shape;
}

/** 字符串净化：非字符串/空 ⇒ undefined；否则截断（Token 纪律与隐私截断）。
 *  （原定义于队列段；主账本的分级载荷携带与队列的证据链/恢复面共用 ——
 *  纯函数搬家，签名与行为零变化。） */
export function strOrUndef(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : undefined;
}

/** ΠΑΝ-7（宪法违例修复）：令牌入参的类型收口 —— 非字符串（数字/对象/Symbol/
 *  任意模型输出的 JSON 真值）⇒ ''（= 簿记里必然缺席 ⇒ 结构化拒绝），绝不抛。
 *  旧实现 `(token || '').trim()` 对非字符串真值抛 TypeError（.trim 不是函数），
 *  而 grant_approval 等模型可调工具把 args.token 原样透传 —— 违反「运行层
 *  绝不抛」宪（C1-5 M7 / 批判报告 ΠΑΝ-7）。主账本全方法经此 helper 收口；
 *  actionGate.ts 已对同一威胁模型执行严格类型收口，库内自此两套标准合一。 */
export function normalizeToken(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
