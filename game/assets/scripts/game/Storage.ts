/** 本地持久化：最高分 / 音效 / 震动 / 局数 / 调参覆盖 */
import { sys } from 'cc';
import { DEFAULT_TUNING, PARAM_DEFS, cloneTuning } from '../core/Config';
import type { Tuning } from '../core/Config';

const SAVE_KEY = 'liquid1024.save.v1';
const TUNING_KEY = 'liquid1024.tuning.v1';
const DEBUG_KEY = 'liquid1024.debug.v1';

export interface ScoreRecord {
  score: number;
  maxBall: number;
  merges: number;
  time: number;
  at: number;
}

export interface SaveData {
  best: number;
  sound: boolean;
  vibration: boolean;
  /** 是否显示瞄准虚线与落点预览 */
  aimLine: boolean;
  runs: number;
  /** 首次进入主页的时间，用于后续留存/埋点 */
  installedAt: number;
  /** 新手教学是否已看过 */
  tutorialSeen: boolean;
  /** 本机前 5 高分榜单 */
  records: ScoreRecord[];
}

const DEFAULT_SAVE: SaveData = {
  best: 0,
  sound: true,
  vibration: true,
  aimLine: true,
  runs: 0,
  installedAt: 0,
  tutorialSeen: false,
  records: [],
};

export function loadSave(): SaveData {
  try {
    const raw = sys.localStorage.getItem(SAVE_KEY);
    if (!raw) return { ...DEFAULT_SAVE, installedAt: Date.now(), records: [] };
    const v = JSON.parse(raw) as Partial<SaveData>;
    const records = Array.isArray(v.records)
      ? v.records
          .filter((r) => r && Number.isFinite(r.score) && r.score > 0)
          .slice(0, 5)
      : [];
    return {
      best: Math.max(0, Number(v.best) || 0),
      sound: v.sound !== false,
      vibration: v.vibration !== false,
      aimLine: v.aimLine !== false,
      runs: Math.max(0, Number(v.runs) || 0),
      installedAt: Number(v.installedAt) || Date.now(),
      tutorialSeen: v.tutorialSeen === true,
      records,
    };
  } catch {
    return { ...DEFAULT_SAVE, installedAt: Date.now(), records: [] };
  }
}

export function persistSave(data: SaveData): void {
  try {
    sys.localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    /* 隐私模式/存储满：静默失败，不影响对局 */
  }
}

export function loadTuning(): Tuning {
  try {
    const raw = sys.localStorage.getItem(TUNING_KEY);
    if (!raw) return cloneTuning(DEFAULT_TUNING);
    const saved = JSON.parse(raw) as Partial<Tuning>;
    const out = cloneTuning(DEFAULT_TUNING);
    (Object.keys(out) as (keyof Tuning)[]).forEach((k) => {
      const v = saved[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    });
    // 存档可能来自旧版本/手改，按 §4.8 建议范围夹取，避免坏参数进对局
    for (const def of PARAM_DEFS) {
      const v = out[def.key] as number;
      (out as unknown as Record<string, number>)[def.key] = Math.min(def.max, Math.max(def.min, v));
    }
    return out;
  } catch {
    return cloneTuning(DEFAULT_TUNING);
  }
}

export function persistTuning(t: Tuning): void {
  try {
    sys.localStorage.setItem(TUNING_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}

/** 调参面板开关：默认关（发版口径）；调试口令或手动置 1 可在原型期打开 */
export function isDebugEnabled(): boolean {
  try {
    return sys.localStorage.getItem(DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDebugEnabled(on: boolean): void {
  try {
    sys.localStorage.setItem(DEBUG_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** 写入单局成绩并保留前 5 名高分榜 */
export function recordScore(score: number, maxBall: number, merges: number, time: number): SaveData {
  const data = loadSave();
  if (score > 0) {
    data.records.push({
      score: Math.round(score),
      maxBall,
      merges,
      time: Math.round(time),
      at: Date.now(),
    });
    data.records.sort((a, b) => b.score - a.score);
    data.records = data.records.slice(0, 5);
    if (score > data.best) data.best = Math.round(score);
  }
  persistSave(data);
  return data;
}

/** 清空最高分（设置页二次确认后调用） */
export function resetBest(): SaveData {
  const data = loadSave();
  data.best = 0;
  data.records = [];
  persistSave(data);
  return data;
}
