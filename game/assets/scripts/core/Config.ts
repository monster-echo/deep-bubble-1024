/**
 * Liquid1024 · 全局数值配置
 *
 * 本文件是 GAME.md §4 的代码映射，所有键名与 §4.8 调参面板一致。
 * 纯数据 + 纯函数，不 import 'cc'，便于 Node 下做规则回归测试。
 */

/** 11 级球链（2 … 2048） */
export const BALL_VALUES = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048] as const;
export type BallValue = (typeof BALL_VALUES)[number];

/** §4.2 半径表（设计坐标，球场 660×980） */
export const RADIUS: Record<number, number> = {
  2: 18,
  4: 22,
  8: 27,
  16: 33,
  32: 40,
  64: 48,
  128: 58,
  256: 70,
  512: 84,
  1024: 101,
  2048: 121,
};

/** §5 色阶，用于水花/涟漪/球体描边等程序化效果 */
export const BALL_COLORS: Record<number, string> = {
  2: '#8FF0D8',
  4: '#8FE6F7',
  8: '#7CCBFF',
  16: '#6E9BFF',
  32: '#6FE3B0',
  64: '#A78BFA',
  128: '#FFB347',
  256: '#FF8FA3',
  512: '#5B7CFF',
  1024: '#FFD24A',
  2048: '#7CECF5',
};

export const BALL_COLOR_RGB: Record<number, [number, number, number]> = {};
for (const key of Object.keys(BALL_COLORS)) {
  const h = BALL_COLORS[Number(key)];
  BALL_COLOR_RGB[Number(key)] = [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

/** §4.1 球场几何（大水箱全视野布局） */
export const TANK = {
  width: 680,
  height: 1040,
  topY: 1040,
  turretX: 340,
  turretY: 56,
  muzzleX: 340,
  muzzleY: 112,
  lineY: 200,
  aimFanDeg: 144,
  /** 完整弹道预览长度 */
  aimLineLen: 2200,
  /** 按住蓄力射速区间（40% 轻射 ~ 100% 满蓄力高压水弹） */
  launchSpeedMin: 1180,
  launchSpeedMax: 2100,
  launchSpeed: 1650,
  /** 向上水下浮力加速度 */
  buoyancy: 620,
  /** 飞球初段轻阻尼 / 水堆结算阻尼 */
  flightDrag: 0.55,
  waterDrag: 2.35,
} as const;

/** §4.7 无尽阶段（时间单位：秒） */
export interface Phase {
  readonly key: string;
  readonly name: string;
  readonly start: number;
  readonly pool: number;
  /** 该阶段扫动单程；函数用于 0.90→0.80、深海衰减 */
  sweepAt: (t: number) => number;
  lineAt: (t: number) => number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** §4.7 + §4.4：阶段只看时间 */
export const PHASES: Phase[] = [
  { key: 'P0', name: '热身', start: 0, pool: 0, sweepAt: () => 1.20, lineAt: () => 200 },
  { key: 'P1', name: '起步', start: 30, pool: 1, sweepAt: () => 1.10, lineAt: () => 200 },
  { key: 'P2', name: '加速', start: 90, pool: 2, sweepAt: () => 1.00, lineAt: () => 200 },
  {
    key: 'P3',
    name: '高压',
    start: 150,
    pool: 3,
    sweepAt: (t) => (t < 240 ? 0.90 : 0.80),
    lineAt: () => 200,
  },
  {
    key: 'P4',
    name: '极限',
    start: 390,
    pool: 4,
    // 6:30-8:00：0.72；7:00/8:00 警戒线各 +10
    sweepAt: () => 0.72,
    lineAt: (t) => 200 + (t >= 420 ? 10 : 0) + (t >= 480 ? 10 : 0),
  },
  {
    key: 'DEEP',
    name: '深海',
    start: 480,
    pool: 4,
    // 8:00 后 0.65，每 48s -0.02，地板 0.55；警戒线 220 起，每 40s +10，封顶 280
    sweepAt: (t) => Math.max(0.55, 0.65 - 0.02 * Math.floor(Math.max(0, t - 480) / 48)),
    lineAt: (t) => Math.min(280, 220 + 10 * Math.floor(Math.max(0, t - 480) / 40)),
  },
];

export function phaseIndexAt(t: number): number {
  let idx = 0;
  for (let i = 1; i < PHASES.length; i++) {
    if (t >= PHASES[i].start) idx = i;
  }
  return idx;
}

export function sweepPeriodAt(t: number, tuning: Tuning): number {
  const phase = PHASES[phaseIndexAt(t)];
  // 面板 sweep.period 作为 P0 基准，阶段表按比例缩放
  const scaled = phase.sweepAt(t) * (tuning.sweepPeriod / 1.2);
  return Math.max(tuning.sweepFloor, Math.min(2.2, scaled));
}

export function lineYAt(t: number, tuning: Tuning): number {
  const phase = PHASES[phaseIndexAt(t)];
  // 阶段表以 200 为基准；面板 line.y 可整体抬高/降低
  const rise = Math.max(0, phase.lineAt(t) - 200);
  return Math.min(tuning.lineCap, tuning.lineY + rise);
}

/** §4.4 发球池，行=P0..P4，列=2/4/8/16/32/64 */
export const SPAWN_VALUES = [2, 4, 8, 16, 32, 64] as const;
export const SPAWN_WEIGHTS: readonly (readonly number[])[] = [
  [40, 35, 25, 0, 0, 0],
  [25, 30, 30, 15, 0, 0],
  [15, 22, 28, 25, 10, 0],
  [10, 15, 22, 28, 20, 5],
  [8, 12, 18, 28, 26, 8],
];

/** §4.5 计分常量 */
export const SCORE = {
  first1024: 5000,
  first2048: 20000,
  dropPerBall: 10,
  drainPerBall: 10,
  deepStep: 0.15,
  deepCap: 3.0,
} as const;

/** §4.8 调参项定义（顺序即面板顺序） */
export interface ParamDef {
  key: keyof Tuning;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  digits?: number;
  hint?: string;
}

export interface Tuning {
  lineY: number;
  aimFanDeg: number;
  sweepPeriod: number;
  vMin: number;
  vMax: number;
  vGamma: number;
  dragK: number;
  wallRest: number;
  maxBounce: number;
  stopSpeed: number;
  squeezeRatioMin: number;
  squeezeRatioMax: number;
  squeezeRatioGamma: number;
  squeezeMinSpeed: number;
  squeezeMinDepth: number;
  squeezeTimeMin: number;
  squeezeTimeMax: number;
  comboStep: number;
  comboCap: number;
  squeezeBonus: number;
  basePerValue: number;
  pityAfter: number;
  pityBoost: number;
  drainCount: number;
  drainScore: number;
  magnetMax: number;
  magnetScoreFactor: number;
  reviveSeconds: number;
  revivePerSecond: number;
  sweepFloor: number;
  lineRiseStep: number;
  lineRiseEvery: number;
  sweepDecay: number;
  lineCap: number;
  hardCap: number;
  first1024: number;
  first2048: number;
  depthStep: number;
  depthCap: number;
}

/** GAME.md §4.8 默认值 */
export const DEFAULT_TUNING: Tuning = {
  lineY: 200,
  aimFanDeg: 140,
  sweepPeriod: 1.20,
  vMin: 600,
  vMax: 1600,
  vGamma: 1.15,
  dragK: 0.28,
  wallRest: 0.68,
  maxBounce: 3,
  stopSpeed: 120,
  squeezeRatioMin: 0.55,
  squeezeRatioMax: 0.60,
  squeezeRatioGamma: 2.0,
  squeezeMinSpeed: 280,
  squeezeMinDepth: 0.75,
  squeezeTimeMin: 0.12,
  squeezeTimeMax: 0.45,
  comboStep: 0.5,
  comboCap: 4.0,
  squeezeBonus: 0.25,
  basePerValue: 10,
  pityAfter: 6,
  pityBoost: 15,
  drainCount: 5,
  drainScore: 10,
  magnetMax: 8,
  magnetScoreFactor: 2,
  reviveSeconds: 3,
  revivePerSecond: 5,
  sweepFloor: 0.55,
  lineRiseStep: 10,
  lineRiseEvery: 40,
  sweepDecay: 48,
  lineCap: 280,
  hardCap: 720,
  first1024: 5000,
  first2048: 20000,
  depthStep: 0.15,
  depthCap: 3.0,
};

export const PARAM_DEFS: ParamDef[] = [
  { key: 'lineY', label: '警戒线 y', group: '球场', min: 200, max: 280, step: 5 },
  { key: 'aimFanDeg', label: '瞄准扇区', group: '瞄准', min: 120, max: 160, step: 2, hint: '总角度' },
  { key: 'sweepPeriod', label: '扫动单程', group: '瞄准', min: 0.5, max: 1.5, step: 0.05, digits: 2, hint: '秒' },
  { key: 'vMin', label: '力度0初速', group: '发射', min: 500, max: 1800, step: 10 },
  { key: 'vMax', label: '力度100初速', group: '发射', min: 500, max: 1800, step: 10 },
  { key: 'vGamma', label: '力度曲线', group: '发射', min: 1.0, max: 1.4, step: 0.05, digits: 2 },
  { key: 'dragK', label: '水中阻尼', group: '发射', min: 0.2, max: 0.4, step: 0.01, digits: 2 },
  { key: 'wallRest', label: '墙面恢复', group: '发射', min: 0.5, max: 0.8, step: 0.02, digits: 2 },
  { key: 'maxBounce', label: '最大反弹', group: '发射', min: 2, max: 5, step: 1 },
  { key: 'stopSpeed', label: '停止阈值', group: '发射', min: 80, max: 200, step: 10 },
  { key: 'squeezeRatioMin', label: '满力挤缝', group: '挤缝', min: 0.5, max: 0.65, step: 0.01, digits: 2 },
  { key: 'squeezeRatioMax', label: '轻力挤缝', group: '挤缝', min: 0.5, max: 0.65, step: 0.01, digits: 2 },
  { key: 'squeezeRatioGamma', label: '挤缝曲线', group: '挤缝', min: 1, max: 3, step: 0.1, digits: 1 },
  { key: 'squeezeMinSpeed', label: '挤缝最低速', group: '挤缝', min: 200, max: 400, step: 10 },
  { key: 'squeezeMinDepth', label: '最小缝深', group: '挤缝', min: 0.5, max: 1.0, step: 0.05, digits: 2, hint: '×球径' },
  { key: 'squeezeTimeMin', label: '钻入最短', group: '挤缝', min: 0.08, max: 0.25, step: 0.01, digits: 2 },
  { key: 'squeezeTimeMax', label: '钻入最长', group: '挤缝', min: 0.25, max: 0.6, step: 0.01, digits: 2 },
  { key: 'comboStep', label: 'Combo 增量', group: '合并', min: 0.3, max: 0.7, step: 0.05, digits: 2 },
  { key: 'comboCap', label: 'Combo 封顶', group: '合并', min: 3.0, max: 5.0, step: 0.1, digits: 1 },
  { key: 'squeezeBonus', label: '挤入加成', group: '合并', min: 0, max: 0.5, step: 0.05, digits: 2 },
  { key: 'basePerValue', label: '合并分系数', group: '合并', min: 5, max: 20, step: 1 },
  { key: 'pityAfter', label: '保底触发', group: '发球', min: 4, max: 10, step: 1, hint: '发' },
  { key: 'pityBoost', label: '保底权重', group: '发球', min: 5, max: 30, step: 1 },
  { key: 'drainCount', label: '排水颗数', group: '道具', min: 3, max: 7, step: 1 },
  { key: 'drainScore', label: '排水每颗分', group: '道具', min: 0, max: 30, step: 5 },
  { key: 'magnetMax', label: '磁铁最多个', group: '道具', min: 4, max: 12, step: 1 },
  { key: 'magnetScoreFactor', label: '磁铁分系数', group: '道具', min: 0, max: 5, step: 1 },
  { key: 'reviveSeconds', label: '复活排水秒', group: '道具', min: 2, max: 5, step: 1 },
  { key: 'revivePerSecond', label: '复活每秒颗', group: '道具', min: 3, max: 8, step: 1 },
  { key: 'sweepFloor', label: '扫速地板', group: '无尽', min: 0.45, max: 0.7, step: 0.01, digits: 2 },
  { key: 'lineRiseStep', label: '警戒线上移', group: '无尽', min: 5, max: 20, step: 1 },
  { key: 'lineRiseEvery', label: '上移间隔', group: '无尽', min: 30, max: 90, step: 5, hint: '秒' },
  { key: 'sweepDecay', label: '扫速衰减', group: '无尽', min: 30, max: 90, step: 5, hint: '秒' },
  { key: 'lineCap', label: '警戒线上限', group: '无尽', min: 240, max: 320, step: 5 },
  { key: 'hardCap', label: '单局硬上限', group: '无尽', min: 480, max: 900, step: 30, hint: '秒' },
  { key: 'first1024', label: '首达 1024', group: '计分', min: 0, max: 20000, step: 500 },
  { key: 'first2048', label: '首达 2048', group: '计分', min: 0, max: 50000, step: 1000 },
  { key: 'depthStep', label: '深度每层', group: '计分', min: 0.05, max: 0.3, step: 0.01, digits: 2 },
  { key: 'depthCap', label: '深度封顶', group: '计分', min: 1.5, max: 5, step: 0.1, digits: 1 },
];

export function cloneTuning(src: Tuning): Tuning {
  return { ...src };
}

/** 深海阶段动态警戒线（面板 lineRiseEvery/step 覆盖 §4.7 默认） */
export function deepLineAt(t: number, tuning: Tuning): number {
  if (t < 480) return lineYAt(t, tuning);
  const rise = tuning.lineRiseStep * Math.floor(Math.max(0, t - 480) / Math.max(30, tuning.lineRiseEvery));
  const base = tuning.lineY + 20; // 8:00 时基础已累计 +20
  return Math.min(tuning.lineCap, base + rise);
}

/** 深海段动态扫速（面板 sweepDecay 覆盖默认 48s） */
export function deepSweepAt(t: number, tuning: Tuning): number {
  if (t < 480) return sweepPeriodAt(t, tuning);
  const decay = 0.02 * Math.floor(Math.max(0, t - 480) / Math.max(30, tuning.sweepDecay));
  const scaled = (0.65 - decay) * (tuning.sweepPeriod / 1.2);
  return Math.max(tuning.sweepFloor, scaled);
}

/** §4.3 力度 → 初速 / 挤缝系数 */
export function speedForPower(power01: number, tuning: Tuning): number {
  const p = clamp(power01, 0, 1);
  return tuning.vMin + (tuning.vMax - tuning.vMin) * Math.pow(p, tuning.vGamma);
}

/** 水下浮力 1024 按住蓄力射速（power ∈ [0, 100]） */
export function launchSpeedForPower(power: number): number {
  const p = clamp(power / 100, 0, 1);
  return TANK.launchSpeedMin + (TANK.launchSpeedMax - TANK.launchSpeedMin) * Math.pow(p, 0.9);
}

export function squeezeRatioForPower(power01: number, tuning: Tuning): number {
  const p = clamp(power01, 0, 1);
  const span = tuning.squeezeRatioMax - tuning.squeezeRatioMin;
  return tuning.squeezeRatioMax - span * Math.pow(p, tuning.squeezeRatioGamma);
}

/** §4.5 Combo 倍率；n 从 1 开始 */
export function comboMultiplier(n: number, tuning: Tuning): number {
  if (n <= 1) return 1;
  return Math.min(tuning.comboCap, 1 + tuning.comboStep * (n - 1));
}

/** §4.5 无尽深度倍率 */
export function depthMultiplier(depth: number, tuning: Tuning): number {
  return Math.min(tuning.depthCap, 1 + tuning.depthStep * depth);
}

/** 无序数组工具 */
export function clampNumber(v: number, lo: number, hi: number): number {
  return clamp(v, lo, hi);
}

/** 可复现随机数（mulberry32） */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}