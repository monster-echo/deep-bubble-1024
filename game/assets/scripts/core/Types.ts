/** 运行时数据结构 & 事件协议（纯 TS，不依赖 Cocos） */
import type { Tuning } from './Config';

export type BallState = 'stack' | 'falling';

export type ItemKind = 'drain' | 'melt' | 'magnet';
export type ItemCounts = Record<ItemKind, number>;

export interface Ball {
  id: number;
  value: number;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: BallState;
  anchored: boolean;
  age: number;
  wobblePhase: number;
  fallVx: number;
  fallVy: number;
  /** 最近一次合并/生成时刻，用于弹入动画 */
  bornAt: number;
  /** 发射时刻（仅对刚射出的球有效，用于初段低阻尼飞行与警戒线豁免） */
  launchedAt: number;
  /** 链式合并短冷却，让多段连锁逐帧可见 */
  mergeLockUntil: number;
  /** 万能彩球：可与任意数字球相撞合并升级 */
  wild?: boolean;
  /** 满力穿透截止时间：95%+ 满力发射前 0.36s 推开挡路小球并一击破冰 */
  pierceUntil?: number;
  /** 冰封气泡：需撞击破冰（或满力直接穿透击碎）后才可合并 */
  iced?: boolean;
  /** 排水/融化时给视图的消失原因 */
  removeReason?: 'drain' | 'melt' | 'magnet' | 'celebrate';
}

export interface Shot {
  id: number;
  value: number;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  power: number;
  squeezeRatio: number;
  bounces: number;
  bornAt: number;
  squeezed: boolean;
  squeeze: null;
  ignoreA: number;
  ignoreB: number;
  ignoreUntil: number;
}

export interface AimPrediction {
  pts: { x: number; y: number }[];
  hitKind: 'none' | 'top' | 'stick' | 'merge' | 'squeeze' | 'squeeze_merge';
  hitX: number;
  hitY: number;
  targetBallId?: number;
}

export type WallSide = 'left' | 'right' | 'top';

export type WorldEvent =
  | { type: 'loaded'; current: number; next: number }
  | { type: 'swap'; current: number; next: number }
  | { type: 'fire'; x: number; y: number; angle: number; power: number; speed: number; value: number; ballId: number }
  | { type: 'bounce'; x: number; y: number; wall: WallSide; ballId?: number }
  | { type: 'collide'; x: number; y: number; aId: number; bId: number; nx: number; ny: number; speed: number }
  | { type: 'stick'; ball: Ball; power: number }
  | {
      type: 'merge';
      x: number;
      y: number;
      value: number;
      score: number;
      combo: number;
      squeezed: boolean;
      chain: boolean;
      ball: Ball;
      streak?: number;
      fever?: boolean;
    }
  | { type: 'tier'; value: number; x: number; y: number }
  | { type: 'streak'; streak: number; fever: boolean }
  | { type: 'wildReady' }
  | { type: 'iceBreak'; x: number; y: number; value: number }
  | { type: 'vortex'; active: boolean; cx: number; cy: number }
  | { type: 'tide'; count: number; wave: number }
  | { type: 'drop'; ids: number[]; count: number; score: number }
  | { type: 'remove'; id: number; reason: 'drain' | 'melt' | 'magnet' | 'celebrate' | 'fall' }
  | { type: 'reload' }
  | { type: 'defeat'; reason: 'line' | 'hardcap'; score: number }
  | { type: 'first1024'; x: number; y: number; score: number }
  | { type: 'first2048'; x: number; y: number; score: number }
  | { type: 'phase'; index: number; lineY: number; sweepPeriod: number }
  | { type: 'depth'; depth: number; multiplier: number }
  | { type: 'reviveStart'; waves: number }
  | { type: 'reviveWave'; count: number }
  | { type: 'reviveEnd' }
  | { type: 'item'; kind: 'drain' | 'melt' | 'magnet'; removed: number }
  | { type: 'warning'; level: number }
  | { type: 'celebrateEnd'; kind: 1024 | 2048 }
  | { type: 'result'; result: RunResult };

export interface RunResult {
  score: number;
  merges: number;
  maxCombo: number;
  maxBall: number;
  depth: number;
  detached: number;
  time: number;
  reason: 'line' | 'hardcap';
  revived: boolean;
  got1024: boolean;
  got2048: boolean;
}

export type WorldListener = (ev: WorldEvent) => void;

export interface WorldOptions {
  tuning: Tuning;
  seed?: number;
  listener?: WorldListener;
}
