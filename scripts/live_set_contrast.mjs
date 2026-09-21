#!/usr/bin/env node
// scripts/live_set_contrast.mjs
// #17（O 纪元）：Windows set_contrast 真机 SET/undo 往返验证（按需执行 —— 会短暂
// 切换系统高对比度主题后还原，故意不进测试套件）。用法：node scripts/live_set_contrast.mjs
// 2026-09-20 本机首跑：flags 126 → 127 → 126，VERIFIED。
process.env.DSH_TS ??= '1';
const { WindowsAdapter } = await import('../src/environmentShaper.ts');
const a = new WindowsAdapter();
const read = () => a.getHighContrastFlags();
const before = await read();
if (before === null) { console.error('GET failed — PowerShell/PInvoke unavailable'); process.exit(1); }
console.log('BEFORE flags =', before);
const recipe = await a.apply({ kind: 'set_contrast' });
await new Promise(r => setTimeout(r, 800));
const during = await read();
console.log('DURING flags =', during, `(expect ${before | 1})`);
await a.undo(recipe);
await new Promise(r => setTimeout(r, 800));
const after = await read();
console.log('AFTER undo flags =', after, `(expect ${before})`);
const ok = during === (before | 1) && after === before;
console.log('ROUND TRIP:', ok ? 'VERIFIED' : 'MISMATCH');
process.exit(ok ? 0 : 1);
