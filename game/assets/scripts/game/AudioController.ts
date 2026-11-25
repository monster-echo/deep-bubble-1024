/** 音效 + 震动。音效缺失时静默，不影响玩法。 */
import { AudioSource, Node } from 'cc';
import type { AssetHub, AudioName } from './AssetHub';

declare const wx: any;

export class AudioController {
  private source: AudioSource;
  soundOn = true;
  vibrationOn = true;
  private lastDanger = -10;

  constructor(host: Node, private assets: AssetHub) {
    this.source = host.addComponent(AudioSource);
    this.source.playOnAwake = false;
  }

  play(name: AudioName, volume = 0.75): void {
    if (!this.soundOn) return;
    const clip = this.assets.audio[name];
    if (!clip) return;
    this.source.playOneShot(clip, volume);
  }

  /** 连击合并按五声音阶升调播放（C5 -> D5 -> E5 -> G5 -> A5 -> C6） */
  playMerge(combo: number, volume = 0.75): void {
    const idx = Math.max(1, Math.min(6, combo)) as 1 | 2 | 3 | 4 | 5 | 6;
    const key = `merge_${idx}` as AudioName;
    if (this.assets.audio[key]) {
      this.play(key, volume);
    } else {
      this.play('merge', volume);
    }
  }

  /** 高光连消播报音效（Great / Amazing / Unstoppable / Legendary） */
  playAnnounce(kind: 'great' | 'amazing' | 'unstoppable' | 'legend', volume = 0.85): void {
    const key = `voice_${kind}` as AudioName;
    this.play(key, volume);
  }

  /** 新开一局时重置危险音效限频，避免沿用上一局 runTime */
  resetDanger(): void {
    this.lastDanger = -10;
  }

  /** 危险警告限频 */
  danger(now: number): void {
    if (now - this.lastDanger < 1.1) return;
    this.lastDanger = now;
    this.play('danger', 0.48);
  }

  vibrate(strength: 'light' | 'medium' | 'heavy' = 'light'): void {
    if (!this.vibrationOn) return;
    try {
      if (typeof wx !== 'undefined' && wx && typeof wx.vibrateShort === 'function') {
        wx.vibrateShort({ type: strength });
      } else if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(strength === 'heavy' ? 30 : strength === 'medium' ? 20 : 12);
      }
    } catch {
      /* 不支持震动 */
    }
  }
}
