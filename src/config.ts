// src/config.ts
// DSH 规范：「两个部署可能想要不同值的一切都必须是配置字段」。
// 原项目地层中散落的全部魔法数字（1280/1440、q60/q75、窗口=3、熔断=3、1000 字符）
// 在此统一收敛为带默认值的配置。
import Schema from '@deepseek-ai/schemastery';

export interface Config {
  /** nut-js 鼠标移动速度(ms)，值越大移动越慢、越像人类（来自「双手纪元」） */
  mouseSpeed: number;
  /** 截图压缩宽度。纯视觉架构下画质优先，故默认 1440 而非 1280（来自「纯视觉定型纪元」） */
  compressWidth: number;
  /** JPEG 压缩质量，Token 杀手三参数之一（来自「Token 经济纪元」） */
  jpegQuality: number;
  /** SoM 网格分割数，0 = 关闭网格（来自 readme 承诺，原代码缺失，此处补全） */
  gridDivisions: number;
  /** 上下文滑动窗口保留的真实图片数（来自 contextManager 地层） */
  maxImageCount: number;
  /** 熔断阈值：连续失败次数（来自「守卫纪元」） */
  maxConsecutiveFailures: number;
  /** type_text 单次输入长度上限，防注入超长文本（来自 typeText 早期地层，迭代中曾丢失，此处找回） */
  maxTextLength: number;
  /** 启用 UI 元素 ID 寻址混合模式（来自「结构化清单纪元」，需注入无障碍 Provider） */
  enableElementIdMode: boolean;
  /** 本地视觉模型地址（如 http://127.0.0.1:8000/parse_gui），留空禁用（来自「混合架构纪元」） */
  localVisionApi: string;
}

export const Config: Schema<Config> = Schema.object({
  mouseSpeed: Schema.number().default(1500).description('nut-js mouseSpeed(ms), larger = more human-like'),
  compressWidth: Schema.number().default(1440).description('Screenshot resize width in px'),
  jpegQuality: Schema.number().default(75).description('JPEG quality 0-100'),
  gridDivisions: Schema.number().default(10).description('SoM grid divisions per axis, 0 disables'),
  maxImageCount: Schema.number().default(3).description('Sliding-window: max real images kept in context'),
  maxConsecutiveFailures: Schema.number().default(3).description('Circuit breaker threshold'),
  maxTextLength: Schema.number().default(1000).description('Max chars per type_text call'),
  enableElementIdMode: Schema.boolean().default(false).description('Enable element-ID addressing (needs accessibility provider)'),
  localVisionApi: Schema.string().default('').description('Local vision model endpoint, empty = disabled'),
});
