// src/contextManager.ts
// 上下文滑动窗口 —— 原项目质量最高的模块，核心逻辑原样保留：
//   有界记忆（N 张图）+ 无限历史（文字降级）+ 保序时间线 + 收缩全透明。
// 融合修复：media_type 不再硬编码 png，从 data URL 前缀解析真实类型；
//           新增 configure()/reset() 以符合 DSH 配置与生命周期规范。
export interface ScreenshotRecord {
  id: number;
  timestamp: number;
  base64: string; // 仅最新几张保留图片数据；置空即「已降级」（空字符串天然 falsy）
  textSummary?: string; // 旧截图降级后的文本描述
}

class ContextManager {
  private history: ScreenshotRecord[] = [];
  private maxImageCount: number;

  constructor(maxImageCount: number = 3) {
    this.maxImageCount = maxImageCount;
  }

  /** DSH 配置规范：窗口宽度由 cordis.yml 决定，而非代码常量 */
  configure(maxImageCount: number) {
    this.maxImageCount = maxImageCount;
  }

  /** 生命周期规范：插件卸载时清空历史（由入口的 ctx.effect disposer 调用） */
  reset() {
    this.history = [];
  }

  /**
   * 添加新截图并执行降级清理。
   * 返回 { currentId, message }：currentId 供状态锚点引用，message 直接喂给模型。
   */
  public addScreenshot(base64: string): { currentId: number; message: string } {
    // Date.now() 一值三用：唯一且单调递增的 id、timestamp、以及「id 升序 = 时间序」
    // 的隐含保证 —— 后文 find 取首个有图记录即最旧图，排序算法被彻底省略。
    const newId = Date.now();

    this.history.push({ id: newId, timestamp: newId, base64 });

    // 不变量恢复式驱逐：反复问「图片数还超标吗」，而非计算该驱逐几张。
    // 即便未来一次 push 多张，这段逻辑无需修改依然正确。
    let evictedMessage = '';
    while (this.history.filter(h => h.base64).length > this.maxImageCount) {
      const oldestImage = this.history.find(h => h.base64);
      if (oldestImage) {
        // 降级话术三要素：时间属性 + 原因 + 行为指引 —— 防模型对已驱逐图产生幻觉或执着
        oldestImage.textSummary =
          `[System Note: Screenshot #${oldestImage.id} was taken earlier and has been cleared ` +
          `from memory to save context space. Rely on the most recent screenshots for current UI state.]`;
        oldestImage.base64 = ''; // 释放内存；置空与谓词翻转原子地同时发生
        evictedMessage += ' (Note: An older screenshot was cleared to prevent context overflow.)';
      }
    }

    // 驱逐不静默：每次上下文收缩都对模型透明
    return {
      currentId: newId,
      message: `Screenshot #${newId} captured successfully.${evictedMessage}`,
    };
  }

  /**
   * 投影为模型线缆格式（Anthropic 多模态 content block）。
   * 存储模型与视图模型分离；for-of 保序输出 -> 降级占位符留在历史位置，时间线永不断裂。
   */
  public getContextForModel(): Array<{ type: string; [key: string]: any }> {
    const content: Array<{ type: string; [key: string]: any }> = [];
    for (const record of this.history) {
      if (record.base64) {
        // 从 data URL 解析真实 MIME 与裸 base64 —— 格式转换压缩到唯一一行、唯一一处
        const match = record.base64.match(/^data:([^;]+);base64,(.*)$/s);
        if (match) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] },
          });
        }
      } else if (record.textSummary) {
        content.push({ type: 'text', text: record.textSummary });
      }
    }
    return content;
  }
}

// 单例是正确的：屏幕只有一块、会话只有一条，截图历史天然全局单份。
export const contextManager = new ContextManager(3);
