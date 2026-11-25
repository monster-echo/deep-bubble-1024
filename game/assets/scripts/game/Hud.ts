/**
 * 极简纯净 1024 对局 HUD：
 * - 顶栏：紧凑「分数」「最高分」「暂停」；连合沸腾时动态浮出
 * - 底栏：左侧三枚手绘图标道具（排水/融化/磁铁），右侧「下一发 / ⇄ 换球」，中间留空给居中炮台
 */
import { BlockInputEvents, Button, Color, Label, Node, Sprite, UIOpacity, UITransform } from 'cc';
import type { BallWorld } from '../core/BallWorld';
import type { ItemCounts, ItemKind } from '../core/Types';
import type { AssetHub } from './AssetHub';
import {
  addButton,
  addLabel,
  addScoreCapsule,
  formatNumber,
  hex,
  makeNode,
  opacityOf,
  setButtonEnabled,
} from './UiKit';

export interface HudCallbacks {
  onPause: () => void;
  onItem: (kind: ItemKind) => void;
  onSwap: () => void;
}

interface ItemChip {
  node: Node;
  badge: Label;
  sub: Label;
}

export class Hud {
  readonly root: Node;
  private scoreLabel: Label;
  private scorePop = 0;
  private bestLabel: Label;
  private streakLabel: Label;
  private streakOp: UIOpacity;
  private comboLabel: Label;
  private comboOp: UIOpacity;
  private comboTime = 0;
  private hintLabel: Label;
  private hintTime = 0;
  private nextSprite: Sprite;
  private nextBtn: Node;
  private swapTag: Label;
  private nextValue = -1;
  private nextWildFlag = false;
  private items: Partial<Record<ItemKind, ItemChip>> = {};
  private pauseBtn: Node;
  private lastScore = -1;
  private lastBest = -1;
  private selecting: ItemKind | null = null;

  constructor(
    parent: Node,
    private assets: AssetHub,
    private height: number,
    private safeTop: number,
    private safeBottom: number,
    private cb: HudCallbacks,
  ) {
    this.root = makeNode('HudLayer', parent, 0, 0, 750, height, 0, 0);
    const H = height - safeTop;
    const B = safeBottom;
    const glass = this.assets.ui.button_glass!;

    // ---- 顶栏：精细矢量深海玻璃胶囊 + 暂停
    addScoreCapsule(this.root, 162, H - 56, 276, 76, { accent: 'cyan' });
    addLabel(this.root, '分数', 162, H - 35, {
      fontSize: 15, bold: true, color: hex('#A8F2FF'), width: 120,
      outline: hex('#063A50', 220), outlineWidth: 2,
    });
    this.scoreLabel = addLabel(this.root, '0', 162, H - 66, {
      fontSize: 31, bold: true, color: hex('#FFFFFF'), width: 240,
      outline: hex('#053A50', 230), outlineWidth: 3,
    });

    addScoreCapsule(this.root, 466, H - 56, 280, 76, { accent: 'gold' });
    addLabel(this.root, '最高分', 466, H - 35, {
      fontSize: 15, bold: true, color: hex('#FFE89C'), width: 120,
      outline: hex('#063A50', 220), outlineWidth: 2,
    });
    this.bestLabel = addLabel(this.root, '0', 466, H - 66, {
      fontSize: 29, bold: true, color: hex('#FFD24A'), width: 240,
      outline: hex('#053A50', 230), outlineWidth: 3,
    });

    this.pauseBtn = addButton(this.root, {
      x: 684, y: H - 56, width: 64, height: 64, frame: this.assets.ui.btn_pause ?? glass,
      sliced: !this.assets.ui.btn_pause,
      onClick: () => this.cb.onPause(),
    });

    // ---- 连合沸腾徽标（位于水箱中下空域，避开炮台装填球与底部红线）
    this.streakLabel = addLabel(this.root, '', 375, 450 + B, {
      fontSize: 20, bold: true, color: hex('#FFE08A'), width: 320, outline: hex('#04283C', 240), outlineWidth: 4,
    });
    this.streakOp = opacityOf(this.streakLabel.node);
    this.streakOp.opacity = 0;

    // ---- Combo 居中大字
    this.comboLabel = addLabel(this.root, '', 375, H * 0.60, {
      fontSize: 40, bold: true, color: hex('#FFE08A'), width: 560, height: 110, lineHeight: 46, outline: hex('#4A1B00', 235), outlineWidth: 5,
    });
    this.comboOp = opacityOf(this.comboLabel.node);
    this.comboOp.opacity = 0;

    // ---- 轻量操作提示（位于沸腾徽标上方，不遮挡炮台当前球）
    this.hintLabel = addLabel(this.root, '', 375, 496 + B, {
      fontSize: 21, bold: true, color: hex('#FFFFFF'), width: 560, outline: hex('#04283C', 240), outlineWidth: 4,
    });
    this.hintLabel.node.active = false;

    // ---- 底栏右侧：下一发（点击可与当前球交换）
    this.nextBtn = makeNode('NextSwapBtn', this.root, 668, 82 + B, 92, 92);
    const frameSp = this.nextBtn.addComponent(Sprite);
    frameSp.sizeMode = Sprite.SizeMode.CUSTOM;
    frameSp.type = Sprite.Type.SLICED;
    frameSp.spriteFrame = this.assets.ui.preview_frame!;
    this.nextBtn.getComponent(UITransform)!.setContentSize(92, 92);
    const nb = this.nextBtn.addComponent(Button);
    nb.transition = Button.Transition.SCALE;
    nb.zoomScale = 0.92;
    nb.duration = 0.08;
    this.nextBtn.addComponent(BlockInputEvents);
    this.nextBtn.on(Button.EventType.CLICK, () => this.cb.onSwap());

    addLabel(this.root, '下一发', 668, 138 + B, {
      fontSize: 15, bold: true, width: 92, color: hex('#DFFFFF'), outline: hex('#063A50', 220), outlineWidth: 2,
    });
    const nextNode = makeNode('nextBall', this.nextBtn, 0, 2, 56, 56);
    this.nextSprite = nextNode.addComponent(Sprite);
    this.nextSprite.sizeMode = Sprite.SizeMode.CUSTOM;
    this.swapTag = addLabel(this.root, '⇄ 换球', 668, 26 + B, {
      fontSize: 14, bold: true, width: 96, color: hex('#8FF0D8'), outline: hex('#063A50', 220), outlineWidth: 2,
    });

    // ---- 底栏左侧：三枚干净手绘图标道具
    this.items.drain = this.makeItem('drain', '排水', 68, 82 + B, this.assets.ui.btn_drain ?? glass);
    this.items.melt = this.makeItem('melt', '融化', 156, 82 + B, this.assets.ui.btn_melt ?? glass);
    this.items.magnet = this.makeItem('magnet', '磁铁', 244, 82 + B, this.assets.ui.btn_magnet ?? glass);

    this.root.active = false;
  }

  private makeItem(kind: ItemKind, text: string, x: number, y: number, frame: any): ItemChip {
    const hasArt = frame !== this.assets.ui.button_glass;
    const node = addButton(this.root, {
      x, y, width: 74, height: 74, text: hasArt ? undefined : text, fontSize: 17, frame,
      sliced: !hasArt,
      onClick: () => this.cb.onItem(kind),
    });
    const badge = addLabel(node, '3', hasArt ? 22 : 24, hasArt ? -20 : 24, {
      fontSize: 18,
      bold: true,
      color: hasArt ? hex('#FFFFFF') : hex('#FFD24A'),
      width: 34,
      outline: hasArt ? hex('#7A3B00', 245) : hex('#063A50', 230),
      outlineWidth: 3,
    });
    const sub = addLabel(this.root, text, x, y - 48, {
      fontSize: 14,
      bold: true,
      color: hex('#DFFFFF'),
      width: 68,
      outline: hex('#063A50', 220),
      outlineWidth: 2,
    });
    sub.node.active = hasArt;
    return { node, badge, sub };
  }

  setVisible(v: boolean): void {
    this.root.active = v;
  }

  reset(): void {
    this.lastScore = -1;
    this.lastBest = -1;
    this.nextValue = -1;
    this.nextWildFlag = false;
    this.scorePop = 0;
    this.comboTime = 0;
    this.comboOp.opacity = 0;
    this.streakOp.opacity = 0;
    this.hintTime = 0;
    this.hintLabel.node.active = false;
    this.setSelecting(null);
    this.setSwapAvailable(true);
  }

  setScore(v: number): void {
    if (v === this.lastScore) return;
    if (this.lastScore >= 0 && v > this.lastScore) this.scorePop = 0.16;
    this.lastScore = v;
    this.scoreLabel.string = formatNumber(v);
  }

  setBest(v: number, live = false): void {
    if (v === this.lastBest && !live) return;
    this.lastBest = v;
    this.bestLabel.string = formatNumber(v);
    this.bestLabel.color = live ? hex('#8FF0D8') : hex('#FFD24A');
  }

  setWorld(world: BallWorld): void {
    this.setScore(world.score);
    this.setNext(world.next ?? 0, world.nextWild);
    this.setStreak(world.streak, world.isFever(), world.currentWild || world.nextWild);
    this.setSwapAvailable(world.canSwap());
  }

  setStreak(streak: number, fever: boolean, hasWild = false): void {
    if (streak < 1 && !hasWild) {
      this.streakOp.opacity = 0;
      return;
    }
    this.streakOp.opacity = 255;
    const step = streak % 8;
    if (hasWild || (streak > 0 && step === 0)) {
      this.streakLabel.string = '🌈 彩球已充能!';
      this.streakLabel.color = hex('#FFAEF8');
    } else if (fever) {
      this.streakLabel.string = `🔥 沸腾 ×${streak} · 彩球 ${step}/8`;
      this.streakLabel.color = step >= 6 ? hex('#FFE066') : hex('#FFD24A');
    } else {
      this.streakLabel.string = `🌈 彩球充能 ${step}/8`;
      this.streakLabel.color = hex('#8FF0D8');
    }
  }

  setSwapAvailable(on: boolean): void {
    opacityOf(this.swapTag.node).opacity = on ? 245 : 95;
  }

  setNext(value: number, wild = false): void {
    if (value !== this.nextValue || wild !== this.nextWildFlag) {
      this.nextValue = value;
      this.nextWildFlag = wild;
      const wildArt = wild ? this.assets.ui.wild_orb : undefined;
      const art = this.assets.ball(value);
      if (wildArt) {
        this.nextSprite.node.active = true;
        this.nextSprite.spriteFrame = wildArt;
        this.nextSprite.node.getComponent(UITransform)!.setContentSize(60, 60);
        this.nextSprite.color = Color.WHITE;
      } else if (!art) {
        this.nextSprite.node.active = false;
      } else {
        this.nextSprite.node.active = true;
        this.nextSprite.spriteFrame = art.frame;
        const size = Math.min(68, Math.max(48, 44 * art.displayScale));
        this.nextSprite.node.getComponent(UITransform)!.setContentSize(size, size);
        this.nextSprite.color = Color.WHITE;
      }
      this.swapTag.string = wild ? '🌈 万能!' : '⇄ 换球';
      this.swapTag.color = wild ? hex('#FF9FF3') : hex('#8FF0D8');
    }
  }

  setItems(counts: ItemCounts): void {
    (Object.keys(counts) as ItemKind[]).forEach((kind) => {
      const chip = this.items[kind];
      if (!chip) return;
      const n = counts[kind];
      chip.badge.string = n > 0 ? `${n}` : '+';
      chip.badge.color = n > 0 ? hex('#FFFFFF') : hex('#8FF0D8');
      chip.sub.color = n > 0 ? hex('#DFFFFF') : hex('#9FE9F2');
    });
  }

  setSelecting(kind: ItemKind | null): void {
    this.selecting = kind;
    (Object.keys(this.items) as ItemKind[]).forEach((k) => {
      const chip = this.items[k];
      if (!chip) return;
      const on = k === kind;
      chip.node.setScale(on ? 1.12 : 1, on ? 1.12 : 1, 1);
      const sp = chip.node.getComponent(Sprite);
      if (sp) sp.color = on ? hex('#FFE9A8') : Color.WHITE;
    });
    if (kind) this.showHint('点选一颗球 · 再点道具取消');
    else if (this.hintTime > 0) this.hintLabel.node.active = false;
  }

  showCombo(combo: number, gain: number, mult: number): void {
    if (combo <= 1) return;
    this.comboLabel.string = `${combo} 连消  ×${mult.toFixed(1)}\n+${formatNumber(gain)}`;
    this.comboOp.opacity = 255;
    this.comboLabel.node.setScale(1.22, 1.22, 1);
    this.comboTime = 1.05;
  }

  showHint(text: string, time = 2.0): void {
    this.hintLabel.string = text;
    this.hintLabel.node.active = true;
    this.hintTime = time;
  }

  update(dt: number): void {
    if (this.scorePop > 0) {
      this.scorePop = Math.max(0, this.scorePop - dt);
      const s = 1 + (this.scorePop / 0.16) * 0.14;
      this.scoreLabel.node.setScale(s, s, 1);
    }
    if (this.comboTime > 0) {
      this.comboTime -= dt;
      const t = Math.min(1, this.comboTime / 1.05);
      if (this.comboTime < 0.65) this.comboOp.opacity = Math.round(255 * Math.max(0, t / 0.65));
      const sc = 1 + 0.2 * Math.min(1, this.comboTime / 0.22);
      this.comboLabel.node.setScale(sc, sc, 1);
      if (this.comboTime <= 0) this.comboOp.opacity = 0;
    }
    if (this.hintTime > 0) {
      this.hintTime -= dt;
      if (this.hintTime <= 0) this.hintLabel.node.active = false;
    }
  }

  setPauseEnabled(on: boolean): void {
    setButtonEnabled(this.pauseBtn, on);
  }

  get selectingKind(): ItemKind | null {
    return this.selecting;
  }
}
