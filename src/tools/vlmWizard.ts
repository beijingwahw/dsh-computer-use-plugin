// src/tools/vlmWizard.ts
// 纪元 Λ（Λ-3 开箱即亮）：vlm_wizard —— 打开浏览器连接向导。
// 无 Key 用户的第 0 步：起一个本地向导服务（Λ-2 契约 startOnboarding ——
// 页面引导用户选平台/贴密钥/试连，成功即落档 via:'wizard'），再用系统默认
// 浏览器打开它（system.openUrl —— dryRun 守卫天然继承：守卫拦截时如实注记，
// 绝不谎报「已打开」）。
// 服务是模块级单例：closed/缺席 ⇒ 重起 —— 同一向导地址跨调用稳定，用户
// 刷新页面不换端口；两次调用绝不双起服务。
// 铁律：锚点一律走 toolResult 工厂；起服务/开浏览器失败诚实 toolErr。
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from '../config';
import { system } from '../system';
import { toolOk, toolErr } from '../toolResult';
import { startOnboarding, type OnboardingHandle } from '../vlm/onboarding';

/** vlm_wizard 可注入依赖（测试注入假 opener/假服务，零真网络零真浏览器；缺省走真实管线） */
export interface VlmWizardDeps {
  /** 打开 URL 的壳层供给 —— 缺省 system.openUrl（dryRun 守卫天然继承） */
  opener?: (url: string) => Promise<{ method: string }>;
  /** 向导服务供给 —— 缺省真 startOnboarding（测试注入假 handle 计数复用） */
  server?: () => Promise<OnboardingHandle>;
  /** 向导服务端口覆盖（透传 startOnboarding opts.port；缺省用 Λ-2 的缺省端口） */
  port?: number;
}

/** 模块级向导服务单例 —— closed/缺席 ⇒ 下次调用重起（同一地址跨调用稳定） */
let wizardHandle: OnboardingHandle | null = null;
/** 在途启动去重：并发首次调用共享同一次 startOnboarding（「绝不双起服务」的并发执法） */
let wizardStarting: Promise<OnboardingHandle> | null = null;

/** 测试专用：清空模块级向导单例（生产代码不调用；先例 textReader._setServerOcrFailedAt_forTest） */
export function _resetVlmWizardForTest(): void {
  wizardHandle = null;
  wizardStarting = null;
}

export function createVlmWizardTool(_config: Config, deps: VlmWizardDeps = {}) {
  return defineTool({
    name: 'vlm_wizard',
    description:
      'Opens the browser-based VLM connection wizard — the zeroth step when NO vision model is configured yet ' +
      '(or the current key is broken). The wizard is a local web page that walks the USER through picking a ' +
      'platform, pasting an API key (or choosing a local zero-key brain like Ollama) and test-connecting; on ' +
      'success the connection profile is persisted (via:"wizard") and adopted. Always available — no key needed ' +
      'to open it. The wizard URL stays stable across calls (the local server is reused, not restarted). ' +
      'Use switch_vision_model instead when you already know the platform and key.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      try {
        // 1) 确保向导服务在跑：模块级单例，closed/缺席 ⇒ 重起（绝不双起 ——
        //    并发首次调用经 wizardStarting 去重共享同一次启动）
        const server = deps.server ?? (() => startOnboarding(
          deps.port !== undefined ? { port: deps.port } : undefined,
        ));
        if (wizardHandle === null || wizardHandle.closed) {
          wizardStarting ??= server().finally(() => { wizardStarting = null; });
          wizardHandle = await wizardStarting;
        }
        const handle = wizardHandle;

        // 2) 浏览器打开向导地址 —— system.openUrl（fire-and-forget 壳层；
        //    dryRun 守卫拦截时 method='dry-run'，回执如实注记绝不谎报已打开）
        const opener = deps.opener ?? ((url: string) => system.openUrl(url));
        const { method } = await opener(handle.url);
        const note = method === 'dry-run'
          ? '浏览器已打开连接向导；若未弹出请从宿主控制台日志中的向导地址手动访问（当前 dry-run：dryRun 守卫生效，浏览器实际未被唤起）'
          : '浏览器已打开连接向导；若未弹出请从宿主控制台日志中的向导地址手动访问';
        // ΠΑΝ-20 卫生（F 终验抽查修复）：nonce fragment 绝不进模型上下文 ——
        // handle.url 携 `#<nonce>`，直接回显会把会话凭据交给被提示注入的模型
        // （配合任何宿主侧原始 HTTP 面即可静默重路由视觉流）。向导地址的
        // 模型可见面剥离 fragment；人类手动访问的完整地址在宿主控制台日志
        // （index.ts lightUpVision，带外面）与浏览器地址栏（自动打开时）。
        const publicUrl = handle.url.replace(/#.*$/, '');

        return toolOk(
          `vlm_wizard: connection wizard is up at ${publicUrl} (browser opened via ${method}).`,
          {
            url: publicUrl,
            port: handle.port,
            note,
          },
          'Wait for the USER to finish the wizard (pick platform → paste key → test). The wizard persists the ' +
            'connection profile (via:"wizard") on success. Afterwards verify with vlm_platforms (the platform ' +
            'should show configured / probe ok), or use switch_vision_model to change brains manually. ' +
            'Do not poll aggressively — the wizard is human-paced.',
        );
      } catch (error: any) {
        return toolErr(
          'vlm_wizard failed.',
          error?.message ?? 'unknown error',
          'The wizard server or browser launch failed — retry once (the port may be occupied; nothing user-side ' +
            'is lost). If it keeps failing, configure manually: set the platform env key (e.g. OPENAI_API_KEY / ' +
            'GLM_API_KEY) and call switch_vision_model, or point at a local zero-key brain (platform "ollama").',
        );
      }
    },
  });
}
