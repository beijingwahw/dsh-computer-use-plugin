// test/kernel.conductor.test.ts
// 纪元 Ξ（Ξ-A 进化编排）执法册：全离线注入测试 ——
//   Ξ-C① 缺省 disabled：证据满舱也恒空、report 零账（缺省行为零变化的锚）；
//   Ξ-C② 节流窗：首次 tick 即放行；窗内（差 < minIntervalMs）恒空、不执法；
//   Ξ-C③ 窗后 tick：判决如手算（0.5→1.5→2.5）、report 三账正确、防御副本；
//   Ξ-C④ reset：节流账清零（下次立即放行）、enabled 不动（开关面归宿主）；
//   Ξ-C⑤ 缺省节流窗 300000：299999 恒空 / 300000 放行；垃圾 minIntervalMs 回落缺省；
//   Ξ-C⑥ 校准器故障：tick 抛异常 ⇒ 恒空且**不推进节流账**（故障不是进化）；
//   Ξ-C⑦ src/index.ts 三处接线源码取证 + 缺省 config 零行为锚（桶可导入、
//        Schema 缺省 kernelStatePath=''/kernelEvolutionEnabled=false）。
// 手造 registry/ledger/calibrator（绝不碰生产单例）；时钟注入、零网络零 IO
//（Ξ-C⑦ 的 readFileSync 是只读取证，与既有源码正则测试同法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EvolutionConductor,
  DEFAULT_TICK_INTERVAL_MS,
} from '../src/kernel/conductor.ts';
import type { ConductorOptions } from '../src/kernel/conductor.ts';
import { KernelCalibrator } from '../src/kernel/calibrator.ts';
import type { CalibrationReport } from '../src/kernel/calibrator.ts';
import { KernelRegistry, EvidenceLedger } from '../src/kernel/registry.ts';

/** 手造账本（Θ-2 测试同款）：3 条 (false, margin=1) + nSucc 条 (true, margin=9) */
function feed(ledger: EvidenceLedger, key: string, nFail: number, nSucc: number): void {
  for (let i = 0; i < nFail; i++) ledger.record({ key, success: false, margin: 1, ts: 1 });
  for (let i = 0; i < nSucc; i++) ledger.record({ key, success: true, margin: 9, ts: 1 });
}

/**
 * 标准台架：p ∈ [0,10] 缺省 0.5；账本 n=30 / rate=0.9 / margins 1×3+9×27 ⇒
 * 候选阈 7（{5,9} 并列中位）⇒ 首 tick 步长截断 0.5→1.5，次 tick →2.5（Θ-2 手算复用）。
 * 时钟注入（advance 推进）；节流窗缺省 1000ms。
 */
function makeSetup(minIntervalMs = 1000) {
  let t = 1000;
  const now = () => t;
  const registry = new KernelRegistry();
  registry.register({ key: 'p', organ: 'xi-cond-test', defaultValue: 0.5, min: 0, max: 10 });
  const ledger = new EvidenceLedger();
  feed(ledger, 'p', 3, 27);
  const calibrator = new KernelCalibrator({ registry, ledger, now });
  const conductor = new EvolutionConductor({ registry, ledger, calibrator, minIntervalMs, now });
  return {
    registry, ledger, calibrator, conductor,
    at: () => t,
    advance: (dt: number) => { t += dt; },
  };
}

// ─── Ξ-C①：缺省 disabled（零行为锚） ───

test('Ξ-C①: 缺省 disabled —— 证据满舱 maybeTick 恒空、registry 不动、report 零账', () => {
  const s = makeSetup();
  assert.equal(s.conductor.enabled, false, '缺省关（生产进化总开关 opt-in）');
  assert.deepEqual(s.conductor.maybeTick(), [], 'disabled ⇒ 恒空清单');
  assert.equal(s.registry.get('p'), 0.5, '参数不动（只记账不进化）');
  assert.deepEqual(s.conductor.report(), { ticks: 0, lastTickAt: 0, lastCalibrations: [] }, '零账');
  // 开关往返：关⇒开⇒关，关态恒空不变
  s.conductor.enabled = true;
  assert.equal(s.conductor.enabled, true);
  s.conductor.enabled = false;
  assert.deepEqual(s.conductor.maybeTick(), [], '再关仍恒空');
  assert.equal(s.conductor.enabled, false, 'enabled 赋值归一布尔（垃圾值不翻墙）');
  (s.conductor as unknown as { enabled: unknown }).enabled = 'yes' as never;
  assert.equal(s.conductor.enabled, false, '非 true 赋值按 false 归一');
});

// ─── Ξ-C②：节流窗内不 tick ───

test('Ξ-C②: 节流窗 —— 首次 tick 即放行（0.5→1.5）；窗内差 999 恒空、不执法、账不动', () => {
  const s = makeSetup(1000);
  s.conductor.enabled = true;
  // 首 tick：无「上次」即放行（从未 tick 不设窗）
  const first = s.conductor.maybeTick();
  assert.equal(first.length, 1, '满证据首 tick 出一报告');
  assert.equal(first[0].key, 'p');
  assert.equal(first[0].from, 0.5);
  assert.equal(first[0].to, 1.5, '步长截断（|7−0.5|>1 ⇒ 0.5+1，Θ-2 手算）');
  assert.equal(s.registry.get('p'), 1.5);
  assert.equal(s.conductor.report().ticks, 1);
  assert.equal(s.conductor.report().lastTickAt, 1000);

  // 窗内：差 500 与差 999 皆 < 1000 ⇒ 恒空、值不动、账不动
  s.advance(500);
  assert.deepEqual(s.conductor.maybeTick(), [], '差 500 < 窗 1000 ⇒ 恒空');
  assert.equal(s.registry.get('p'), 1.5);
  s.advance(499); // 累计差 999 —— 恰在窗内
  assert.deepEqual(s.conductor.maybeTick(), [], '差 999（恰窗内）⇒ 恒空');
  assert.deepEqual(s.conductor.report(), {
    ticks: 1,
    lastTickAt: 1000,
    lastCalibrations: [first[0]],
  }, '节流空转不动账');
});

// ─── Ξ-C③：窗后 tick + report 正确性 ───

test('Ξ-C③: 窗后 tick —— 差恰 1000 放行（1.5→2.5）、report 三账正确、返回值防御副本', () => {
  const s = makeSetup(1000);
  s.conductor.enabled = true;
  s.conductor.maybeTick();          // t=1000：0.5→1.5
  s.advance(1000);                   // t=2000：差恰 1000（不 < 窗）⇒ 放行
  const second = s.conductor.maybeTick();
  assert.equal(second.length, 1);
  assert.equal(second[0].from, 1.5);
  assert.equal(second[0].to, 2.5, '二 tick 再走一步（0.1×10 截断）');
  assert.equal(s.registry.get('p'), 2.5);

  const rep = s.conductor.report();
  assert.equal(rep.ticks, 2, '成功 tick 计 2');
  assert.equal(rep.lastTickAt, 2000);
  assert.deepEqual(rep.lastCalibrations, second, 'lastCalibrations = 最后一次 tick 报告');
  // 防御副本：篡改返回数组 / 报告副本不穿透内部账
  second.push({ key: 'hacked', from: 0, to: 1, reason: 'x', generation: 0 });
  rep.lastCalibrations.pop();
  const again = s.conductor.report();
  assert.equal(again.lastCalibrations.length, 1);
  assert.equal(again.lastCalibrations[0].key, 'p');
});

// ─── Ξ-C④：reset ───

test('Ξ-C④: reset —— 节流账清零（下次立即放行）、enabled 不动（开关面归宿主）', () => {
  const s = makeSetup(1000);
  s.conductor.enabled = true;
  s.conductor.maybeTick(); // t=1000
  s.conductor.reset();
  assert.deepEqual(s.conductor.report(), { ticks: 0, lastTickAt: 0, lastCalibrations: [] }, '账清零');
  assert.equal(s.conductor.enabled, true, 'reset 不替宿主关停生产进化');
  // 窗记忆已清：同一时刻立即再放行（2.5 —— registry 现值是注入器官，reset 不处置）
  const immediate = s.conductor.maybeTick(); // 仍在 t=1000
  assert.equal(immediate.length, 1, '无「上次 tick」即放行');
  assert.equal(immediate[0].from, 1.5);
  assert.equal(s.conductor.report().ticks, 1);
});

// ─── Ξ-C⑤：缺省节流窗 300000 + 垃圾回落 ───

test('Ξ-C⑤: 缺省窗 300000 —— 299999 恒空 / 300000 放行；NaN 与负窗回落缺省', () => {
  assert.equal(DEFAULT_TICK_INTERVAL_MS, 300000, '缺省节流窗 = 5 分钟');
  const mk = (minIntervalMs?: number) => {
    let t = 0;
    const registry = new KernelRegistry();
    registry.register({ key: 'p', organ: 'xi-cond-test', defaultValue: 0.5, min: 0, max: 10 });
    const ledger = new EvidenceLedger();
    feed(ledger, 'p', 3, 27);
    const opts = {
      registry, ledger,
      calibrator: new KernelCalibrator({ registry, ledger }),
      ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
      now: () => t,
    } as ConductorOptions;
    const c = new EvolutionConductor(opts);
    c.enabled = true;
    return { c, advance: (dt: number) => { t += dt; } };
  };

  for (const label of ['未给（缺省）', 'NaN', '负值'] as const) {
    const s = mk(label === '未给（缺省）' ? undefined : label === 'NaN' ? Number.NaN : -5);
    assert.equal(s.c.maybeTick().length, 1, `${label}：首 tick 放行`);
    s.advance(299999);
    assert.deepEqual(s.c.maybeTick(), [], `${label}：差 299999 < 300000 ⇒ 恒空`);
    s.advance(1); // 差恰 300000
    assert.equal(s.c.maybeTick().length, 1, `${label}：差 300000 放行`);
    assert.equal(s.c.report().ticks, 2);
  }
});

// ─── Ξ-C⑥：校准器故障（静默降级 + 不推进节流账） ───

test('Ξ-C⑥: 校准器抛异常 —— maybeTick 恒空不抛、节流账不推进（下次原地重试）', () => {
  const boom = {
    tick(): CalibrationReport[] { throw new Error('boom'); },
  } as unknown as KernelCalibrator;
  let t = 1000;
  const registry = new KernelRegistry();
  const ledger = new EvidenceLedger();
  const c = new EvolutionConductor({ registry, ledger, calibrator: boom, minIntervalMs: 1000, now: () => t });
  c.enabled = true;
  assert.deepEqual(c.maybeTick(), [], '故障 ⇒ 恒空（绝不抛）');
  assert.deepEqual(c.report(), { ticks: 0, lastTickAt: 0, lastCalibrations: [] }, '故障不记账');
  t += 5000; // 故障后即便远超窗长：因账未推进，语义仍是「从未成功 tick ⇒ 放行重试」
  assert.deepEqual(c.maybeTick(), [], '持续故障持续静默');
  assert.equal(c.report().ticks, 0);
  // 缺位校准器（防御面）：opts 不给 calibrator ⇒ 恒空不炸
  const bare = new EvolutionConductor({
    registry, ledger, calibrator: undefined as unknown as KernelCalibrator, now: () => t,
  });
  bare.enabled = true;
  assert.deepEqual(bare.maybeTick(), []);
});

// ─── Ξ-C⑦：src/index.ts 三处接线源码取证 + 缺省 config 入口可导入 ───

test('Ξ-C⑦: 接线三处在场 —— 入册后存档复载+编排器铸造 / 用户消息钩子节流 tick / 卸载段 checkpoint 后存档落盘', async () => {
  const entrySrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  // (1) registerProductionKernels() 之后：存档复载 + 编排器铸造 + 总开关接线
  assert.match(entrySrc, /kernelStore = new KernelStore\(config\.kernelStatePath \|\| undefined\);/, '接线①a：KernelStore 以 config.kernelStatePath 铸造（空 = 纯内存）');
  assert.match(entrySrc, /kernelStore\.applyTo\(kernelRegistry, evidenceLedger\);/, '接线①b：存档复载回放进生产注册表');
  assert.match(entrySrc, /conductor = new EvolutionConductor\(\{/, '接线①c：编排器铸造');
  assert.match(entrySrc, /conductor\.enabled = config\.kernelEvolutionEnabled;/, '接线①d：总开关接 config');
  // 顺序即证：复载必须在生产入册之后（存档回放进已入册的生产注册表）
  const regIdx = entrySrc.indexOf('registerProductionKernels();');
  const applyIdx = entrySrc.indexOf('kernelStore.applyTo(kernelRegistry, evidenceLedger);');
  assert.ok(regIdx >= 0 && applyIdx > regIdx, 'applyTo 在 registerProductionKernels 之后');

  // (2) session/event 用户消息钩子内嵌节流 tick（异常全吞）
  assert.match(
    entrySrc,
    /const calibrations = conductor\.maybeTick\(\);\s*\n\s*if \(calibrations\.length\) kernelStore\?\.save\(kernelRegistry, evidenceLedger\);/,
    '接线②：钩子内 maybeTick + 有产出才落存档',
  );
  const hookIdx = entrySrc.indexOf("ctx as any).on('session/event'");
  const tickIdx = entrySrc.indexOf('conductor.maybeTick()');
  assert.ok(hookIdx >= 0 && tickIdx > hookIdx, '节流 tick 位于 session/event 钩子注册之后（闭包持有）');

  // (3) 卸载段：checkpoint 保存后、先于一切 reset 的存档落盘（异常吞）
  //     —— 卸载锚用完整语句（钩子里的同款 save 调用须排除在 indexOf 之外）。
  //     ΠΑΝ-28b 注记：卸载链重构为 runUnloadAction 登记制（异常吞由登记簿统一
  //     提供），锚跟随新结构 —— 执法语义（checkpoint 后、reset 前落盘）不变。
  const unloadSave = "runUnloadAction('kernelStore.save', () => { kernelStore?.save(kernelRegistry, evidenceLedger); });";
  assert.ok(entrySrc.includes(unloadSave), '接线③：卸载段存档落盘（异常吞）');
  const cpIdx = entrySrc.indexOf('saveCheckpoint(config.checkpointPath)');
  const unloadSaveIdx = entrySrc.indexOf(unloadSave);
  const firstResetIdx = entrySrc.indexOf('swarm.syncNow();'); // 卸载清理链的首个 reset 位
  assert.ok(cpIdx >= 0 && unloadSaveIdx > cpIdx, '存档落盘在 checkpoint 之后');
  assert.ok(firstResetIdx > unloadSaveIdx, '存档落盘先于一切 reset（值/证据/代际在清空前交棒）');

  // (4) 桶与 config 双字段在场（interface + Schema 各一处）
  const barrelSrc = readFileSync(new URL('../src/kernel/index.ts', import.meta.url), 'utf8');
  assert.match(barrelSrc, /export \* from '\.\/store';/, '桶导出 store');
  assert.match(barrelSrc, /export \* from '\.\/conductor';/, '桶导出 conductor');
  const configSrc = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  assert.equal((configSrc.match(/kernelStatePath/g) ?? []).length, 2, 'config interface+Schema 各一处 kernelStatePath');
  // ΑΝΒ-4 行为更新（D5 缺席披露）：CONFIG_GATED_TOOLS 册以谓词/键串合法引用
  // kernelEvolutionEnabled（federation_sync 复合门）—— 计数锚定改为声明位
  //（`kernelEvolutionEnabled:`），册引用不再误伤接线三处在场断言。
  assert.equal((configSrc.match(/kernelEvolutionEnabled:/g) ?? []).length, 2, 'config interface+Schema 各一处 kernelEvolutionEnabled（声明位）');

  // (5) 缺省 config 零行为锚：入口消费的内核桶可导入且导出面齐（apply 的全部
  //     新依赖经此一汇）；入口 apply 导出形状在源码在场（src/index.ts 的目录
  //     导入 './vlm' 等是 Node 原生加载器不支持、仓库烟测脚本同律豁免的既有
  //     限制，故以桶导入 + 源码形状替代全量入口导入）；Schema 缺省值逐位核对。
  const kernel = await import('../src/kernel/index.ts');
  assert.equal(typeof kernel.KernelStore, 'function', '桶导出 KernelStore');
  assert.equal(typeof kernel.EvolutionConductor, 'function', '桶导出 EvolutionConductor');
  assert.equal(typeof kernel.KernelCalibrator, 'function', '桶导出 KernelCalibrator');
  assert.equal(typeof kernel.registerProductionKernels, 'function', '桶导出 registerProductionKernels');
  assert.equal(typeof kernel.kernelRegistry?.get, 'function', '桶导出生产注册表单例');
  assert.equal(typeof kernel.evidenceLedger?.record, 'function', '桶导出证据账本单例');
  // 缺省构造即时可用：空路径存档 no-op、编排器缺省关（零行为变化的运行时证）
  const memStore = new kernel.KernelStore();
  assert.deepEqual(memStore.save(kernel.kernelRegistry, kernel.evidenceLedger), { ok: true });
  const memConductor = new kernel.EvolutionConductor({
    registry: kernel.kernelRegistry,
    ledger: kernel.evidenceLedger,
    calibrator: new kernel.KernelCalibrator({ registry: kernel.kernelRegistry, ledger: kernel.evidenceLedger }),
  });
  assert.equal(memConductor.enabled, false);
  assert.deepEqual(memConductor.maybeTick(), []);
  assert.match(entrySrc, /export async function apply\(/, '入口 apply 导出形状在场');
  const { Config } = await import('../src/config.ts');
  const defaults = (Config as unknown as (src: unknown) => Record<string, unknown>)({});
  assert.equal(defaults.kernelStatePath, '', '缺省 kernelStatePath = 空（仅内存）');
  assert.equal(defaults.kernelEvolutionEnabled, false, '缺省 kernelEvolutionEnabled = false（只记账不进化）');
});
