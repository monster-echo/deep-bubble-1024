/**
 * 全屏页面：主页 / 设置 / 暂停 / 败北复活 / 结算 / 新手教学 / 1024 演出 / toast。
 * 全部运行时构建；页面以屏幕左下角为原点，按实际可见高度自适应。
 */
import { Graphics, Label, Node, Sprite, sys, UIOpacity } from 'cc';
import { BALL_COLORS } from '../core/Config';
import type { RunResult } from '../core/Types';
import type { AssetHub } from './AssetHub';
import type { ScoreRecord } from './Storage';
import {
  addButton,
  addDim,
  addLabel,
  addPanel,
  addScoreCapsule,
  addSprite,
  blockInput,
  formatNumber,
  formatTime,
  hex,
  makeNode,
  opacityOf,
  setButtonEnabled,
  setButtonLabel,
} from './UiKit';

const PRIVACY_POLICY_URL = 'https://deep-bubble-legal.pages.dev/privacy/';

export interface ResultSummary {
  result: RunResult;
  score: number;
  best: number;
  newBest: boolean;
  doubled: boolean;
  depthStep: number;
}

export interface MenusCallbacks {
  onStart: () => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onToggleSound: () => boolean;
  onToggleVibration: () => boolean;
  onToggleAimLine: () => boolean;
  onToggleDebug: () => boolean;
  onOpenDebug: () => void;
  onResetBest: () => void;
  onResume: () => void;
  onRestart: () => void;
  onHome: () => void;
  onRevive: () => void;
  onGiveUp: () => void;
  onDoubleScore: () => void;
  onTutorialDone: () => void;
  onOpenTutorial: () => void;
  onOpenRank: () => void;
  onCloseRank: () => void;
}

interface HomeBall {
  node: Node;
  x: number;
  y: number;
  phase: number;
  amp: number;
}

export class Menus {
  readonly root: Node;
  readonly home: Node;
  private settings: Node;
  private pause: Node;
  private result: Node;
  private revive: Node;
  private tutorial: Node;
  private leaderboard: Node;
  private celebration: Node;
  private toastNode: Node;
  private adNode: Node;
  private rankRows: { rank: Label; score: Label; meta: Label }[] = [];
  private homeBalls: HomeBall[] = [];
  private soundOn = true;
  private vibrationOn = true;
  private aimLineOn = true;
  private debugOn = true;
  private resetArmed = 0;
  private toastTime = 0;
  private toastOp: UIOpacity;
  private resultScore!: Label;
  private resultBest!: Label;
  private resultNew!: Label;
  private resultTitle!: Label;
  private resultStats!: Label;
  private doubleBtn!: Node;
  private reviveCount!: Label;
  private reviveDesc!: Label;
  private reviveScore!: Label;
  private reviveLeft = 0;
  private soundBtn!: Node;
  private vibBtn!: Node;
  private aimLineBtn!: Node;
  private debugBtn!: Node;
  private tuningBtn!: Node;
  private resetBtn!: Node;
  private celebrateLabel!: Label;
  private celebrateSub!: Label;
  private celebrateRing!: Sprite;
  private celebrateFlash!: Graphics;
  private celebrateTimer = 0;
  private celebrateDuration = 0;
  private height: number;
  private screenWidth: number;
  private centerY: number;

  constructor(
    private parent: Node,
    private assets: AssetHub,
    height: number,
    private safeTop: number,
    private safeBottom: number,
    private cb: MenusCallbacks,
    screenWidth = 750,
  ) {
    this.height = height;
    this.screenWidth = Math.max(750, screenWidth);
    this.centerY = safeBottom + (height - safeTop - safeBottom) / 2;
    this.root = makeNode('MenuLayer', parent, 0, 0, 750, height, 0, 0);
    this.home = this.buildHome();
    this.settings = this.buildSettings();
    this.pause = this.buildPause();
    this.result = this.buildResult();
    this.revive = this.buildRevive();
    this.tutorial = this.buildTutorial();
    this.leaderboard = this.buildLeaderboard();
    this.celebration = this.buildCelebration();
    this.adNode = this.buildAd();
    this.toastNode = makeNode('toast', this.root, 375, height * 0.8, 680, 60);
    this.toastOp = opacityOf(this.toastNode);
    const toastBg = addSprite(this.toastNode, this.assets.ui.panel_glass!, 0, 0, 680, 58);
    toastBg.type = Sprite.Type.SLICED;
    addLabel(this.toastNode, '', 0, 0, { fontSize: 22, bold: true, color: hex('#FFFFFF'), width: 630 });
    this.toastNode.active = false;
    // toast 文字
    (this.toastNode.children[1] as Node).name = 'toastText';
  }

  // ------------------------------------------------------------------ 构建

  private addFullDim(parent: Node, alpha: number): Node {
    const W = this.screenWidth;
    return addDim(parent, W, this.height, alpha, 375 - W / 2, 0);
  }

  private buildHome(): Node {
    const H = this.height;
    const W = this.screenWidth;
    const top = H - this.safeTop;
    const bottom = this.safeBottom;
    const n = makeNode('Home', this.root, 0, 0, 750, H, 0, 0);
    blockInput(n);

    // 装饰球（漂浮在主标题周围）
    const deco: { v: number; x: number; y: number; size: number; phase: number }[] = [
      { v: 2, x: 120, y: top - 470, size: 66, phase: 0.2 },
      { v: 16, x: 635, y: top - 420, size: 92, phase: 1.4 },
      { v: 128, x: 590, y: top - 610, size: 118, phase: 2.2 },
      { v: 1024, x: 130, y: top - 650, size: 146, phase: 3.1 },
    ];
    for (const d of deco) {
      const art = this.assets.ball(d.v);
      if (!art) continue;
      const s = addSprite(n, art.frame, d.x, d.y, d.size, d.size);
      this.homeBalls.push({ node: s.node, x: d.x, y: d.y, phase: d.phase, amp: 8 + (d.v % 5) * 3 });
    }

    addLabel(n, '深海啵啵 1024', 375, top - 300, {
      fontSize: 78, width: 660, bold: true, color: hex('#FFE08A'), outline: hex('#0A3850', 255), outlineWidth: 8,
      shadow: true,
    });
    addLabel(n, 'D E E P   B U B B L E   1 0 2 4', 375, top - 376, {
      fontSize: 21, width: 600, color: hex('#BFF8FF'), outline: hex('#063A50', 200), outlineWidth: 2,
    });
    addLabel(n, '浮力物理 · 碰撞合并 · 冲向 2048', 375, top - 438, {
      fontSize: 24, color: hex('#DFFFFF'), outline: hex('#063A50', 220), outlineWidth: 3,
    });

    const startY = Math.max(420, H * 0.29) + bottom;
    addButton(n, {
      x: 375, y: startY, width: 430, height: 112, text: '开始游戏', fontSize: 42, frame: this.assets.ui.button_gold!,
      onClick: () => this.cb.onStart(),
    });
    addScoreCapsule(n, 375, startY - 108, 380, 68, { accent: 'gold', icon: 'crown' });
    addLabel(n, '最高分', 240, startY - 108, {
      fontSize: 20, bold: true, color: hex('#D6F8FF'), width: 92, align: Label.HorizontalAlign.LEFT, anchorX: 0,
      outline: hex('#063A50', 220), outlineWidth: 2,
    });
    this.homeBest = addLabel(n, '0', 536, startY - 109, {
      fontSize: 30, bold: true, color: hex('#FFD65A'), width: 210, align: Label.HorizontalAlign.RIGHT, anchorX: 1,
      outline: hex('#05354B', 220), outlineWidth: 3,
    });
    addButton(n, {
      x: 195, y: startY - 205, width: 164, height: 62, text: '怎么玩', fontSize: 22, frame: this.assets.ui.button_glass!,
      onClick: () => this.cb.onOpenTutorial(),
    });
    addButton(n, {
      x: 375, y: startY - 205, width: 164, height: 62, text: '排行榜', fontSize: 22, frame: this.assets.ui.button_glass!,
      onClick: () => this.cb.onOpenRank(),
    });
    addButton(n, {
      x: 555, y: startY - 205, width: 164, height: 62, text: '设置', fontSize: 22, frame: this.assets.ui.button_glass!,
      onClick: () => this.cb.onOpenSettings(),
    });
    addLabel(n, 'v0.6.0', 375, 34 + bottom, {
      fontSize: 17, color: hex('#DFFFFF', 210), outline: hex('#063A50', 190), outlineWidth: 2,
    });
    n.active = false;
    return n;
  }

  private homeBest!: Label;

  private buildSettings(): Node {
    const H = this.height;
    const n = makeNode('Settings', this.root, 0, 0, 750, H, 0, 0);
    const dim = this.addFullDim(n, 195);
    const panel = addPanel(n, this.assets.ui.panel_glass!, 375, this.centerY, 640, 840);
    const p = panel.node;
    addLabel(p, '设置', 0, 352, { fontSize: 42, bold: true, color: hex('#FFE08A') });
    this.soundBtn = addButton(p, {
      x: 0, y: 244, width: 500, height: 74, text: '音效：开', fontSize: 26, frame: this.assets.ui.button_glass!,
      onClick: () => {
        const on = this.cb.onToggleSound();
        this.soundOn = on;
        setButtonLabel(this.soundBtn, `音效：${on ? '开' : '关'}`);
      },
    });
    this.vibBtn = addButton(p, {
      x: 0, y: 152, width: 500, height: 74, text: '震动：开', fontSize: 26, frame: this.assets.ui.button_glass!,
      onClick: () => {
        const on = this.cb.onToggleVibration();
        this.vibrationOn = on;
        setButtonLabel(this.vibBtn, `震动：${on ? '开' : '关'}`);
      },
    });
    this.aimLineBtn = addButton(p, {
      x: 0, y: 60, width: 500, height: 74, text: '瞄准虚线：开', fontSize: 26, frame: this.assets.ui.button_glass!,
      onClick: () => {
        const on = this.cb.onToggleAimLine();
        this.aimLineOn = on;
        setButtonLabel(this.aimLineBtn, `瞄准虚线：${on ? '开' : '关'}`);
      },
    });
    this.debugBtn = addButton(p, {
      x: 0, y: -32, width: 500, height: 72, text: '调试面板：开', fontSize: 24, frame: this.assets.ui.button_glass!,
      onClick: () => {
        const on = this.cb.onToggleDebug();
        this.debugOn = on;
        setButtonLabel(this.debugBtn, `调试面板：${on ? '开' : '关'}`);
      },
    });
    this.tuningBtn = addButton(p, {
      x: 0, y: -116, width: 500, height: 62, text: '打开调参面板', fontSize: 22, frame: this.assets.ui.button_glass!,
      onClick: () => this.cb.onOpenDebug(),
    });
    this.resetBtn = addButton(p, {
      x: 0, y: -196, width: 420, height: 58, text: '清空最高分', fontSize: 20, frame: this.assets.ui.button_glass!,
      onClick: () => {
        if (this.resetArmed <= 0) {
          this.resetArmed = 2.5;
          setButtonLabel(this.resetBtn, '再点一次确认');
        } else {
          this.resetArmed = 0;
          this.cb.onResetBest();
          setButtonLabel(this.resetBtn, '清空最高分');
          this.toast('最高分已清空');
        }
      },
    });
    addButton(p, {
      x: 0, y: -316, width: 280, height: 72, text: '完成', fontSize: 28, frame: this.assets.ui.button_gold!,
      onClick: () => this.cb.onCloseSettings(),
    });
    addButton(p, {
      x: 0, y: -382, width: 300, height: 44, text: '隐私政策 Privacy', fontSize: 17,
      frame: this.assets.ui.button_glass!,
      onClick: () => sys.openURL(PRIVACY_POLICY_URL),
    });
    void dim;
    n.active = false;
    return n;
  }

  private buildPause(): Node {
    const H = this.height;
    const n = makeNode('Pause', this.root, 0, 0, 750, H, 0, 0);
    this.addFullDim(n, 195);
    const panel = addPanel(n, this.assets.ui.panel_glass!, 375, this.centerY, 560, 700);
    const p = panel.node;
    addLabel(p, '暂停', 0, 280, { fontSize: 44, bold: true, color: hex('#FFE08A') });
    addLabel(p, '喘口气，水还在等你', 0, 232, { fontSize: 19, color: hex('#9FE9F2') });
    addButton(p, {
      x: 0, y: 130, width: 420, height: 92, text: '继续游戏', fontSize: 32, frame: this.assets.ui.button_gold!,
      onClick: () => this.cb.onResume(),
    });
    addButton(p, {
      x: 0, y: 20, width: 420, height: 72, text: '重新开始', fontSize: 26, frame: this.assets.ui.button_glass!,
      onClick: () => this.cb.onRestart(),
    });
    addButton(p, {
      x: 0, y: -76, width: 420, height: 72, text: '设置', fontSize: 26, frame: this.assets.ui.button_glass!,
      onClick: () => this.cb.onOpenSettings(),
    });
    addButton(p, {
      x: 0, y: -172, width: 420, height: 66, text: '返回主页', fontSize: 24, frame: this.assets.ui.button_glass!,
      onClick: () => this.cb.onHome(),
    });
    n.active = false;
    return n;
  }

  private buildResult(): Node {
    const H = this.height;
    const n = makeNode('Result', this.root, 0, 0, 750, H, 0, 0);
    this.addFullDim(n, 210);
    const panel = addPanel(n, this.assets.ui.panel_glass!, 375, this.centerY, 640, 980);
    const p = panel.node;
    this.resultTitle = addLabel(p, '本局结束', 0, 412, {
      fontSize: 52, bold: true, color: hex('#FFE08A'), outline: hex('#063A50', 220), outlineWidth: 4,
    });
    addLabel(p, '本局得分', 0, 330, { fontSize: 20, color: hex('#9FE9F2') });
    this.resultScore = addLabel(p, '0', 0, 268, {
      fontSize: 78, bold: true, color: hex('#FFFFFF'), outline: hex('#063A50', 230), outlineWidth: 5,
    });
    this.resultBest = addLabel(p, '最高分 0', 0, 198, { fontSize: 24, color: hex('#FFD24A') });
    this.resultNew = addLabel(p, '新纪录！', 0, 158, {
      fontSize: 24, bold: true, color: hex('#8FF0D8'), outline: hex('#063A50', 220), outlineWidth: 2,
    });
    this.resultNew.node.active = false;
    this.resultStats = addLabel(p, '', 0, 48, {
      fontSize: 21, color: hex('#DFFFFF'), width: 540, height: 156, lineHeight: 32, align: Label.HorizontalAlign.CENTER,
    });
    this.doubleBtn = addButton(p, {
      x: 0, y: -118, width: 440, height: 66, text: '得分 ×2', fontSize: 23,
      frame: this.assets.ui.button_glass!, onClick: () => this.cb.onDoubleScore(),
    });
    addButton(p, {
      x: 0, y: -220, width: 440, height: 90, text: '再来一局', fontSize: 32, frame: this.assets.ui.button_gold!,
      onClick: () => this.cb.onRestart(),
    });
    addButton(p, {
      x: 0, y: -318, width: 330, height: 62, text: '返回主页', fontSize: 23, frame: this.assets.ui.button_glass!,
      onClick: () => this.cb.onHome(),
    });
    n.active = false;
    return n;
  }

  private buildRevive(): Node {
    const H = this.height;
    const n = makeNode('Revive', this.root, 0, 0, 750, H, 0, 0);
    this.addFullDim(n, 205);
    const panel = addPanel(n, this.assets.ui.panel_glass!, 375, this.centerY, 600, 620);
    const p = panel.node;
    addLabel(p, '水位越线', 0, 240, {
      fontSize: 44, bold: true, color: hex('#FF8A98'), outline: hex('#3A0710', 220), outlineWidth: 3,
    });
    this.reviveDesc = addLabel(p, '复活：自动排水 3 秒', 0, 190, { fontSize: 20, color: hex('#DFFFFF') });
    this.reviveScore = addLabel(p, '0', 0, 110, {
      fontSize: 60, bold: true, color: hex('#FFD24A'), outline: hex('#063A50', 230), outlineWidth: 4,
    });
    addLabel(p, '本局得分', 0, 155, { fontSize: 18, color: hex('#9FE9F2') });
    this.reviveCount = addLabel(p, '8', 0, 40, {
      fontSize: 26, color: hex('#BFF8FF'), width: 300,
    });
    addButton(p, {
      x: 0, y: -60, width: 440, height: 92, text: '复活', fontSize: 28, frame: this.assets.ui.button_gold!,
      onClick: () => this.cb.onRevive(),
    });
    addButton(p, {
      x: 0, y: -165, width: 320, height: 60, text: '直接结算', fontSize: 22, frame: this.assets.ui.button_glass!,
      onClick: () => this.cb.onGiveUp(),
    });
    n.active = false;
    return n;
  }

  private buildTutorial(): Node {
    const H = this.height;
    const n = makeNode('Tutorial', this.root, 0, 0, 750, H, 0, 0);
    this.addFullDim(n, 205);
    const panel = addPanel(n, this.assets.ui.panel_glass!, 375, this.centerY, 650, 850);
    const p = panel.node;
    addLabel(p, '怎么玩', 0, 350, { fontSize: 44, bold: true, color: hex('#FFE08A') });
    const rows = [
      ['1', '按住水箱瞄准并蓄力，蓄满力可「高压穿透」推开小球'],
      ['2', '蓄力中拉回炮台即取消并重置力度，上滑可重新蓄力'],
      ['3', '水下暗流聚拢，撞击破除冰封球，同数膨胀引发连消'],
      ['4', '连续 8 连合赠「万能彩球」，定期潮汐会从顶部涌入新球'],
      ['5', '左下 3 枚道具：排水稳水位、融化单球、磁铁吸同数'],
      ['6', '合出 1024 / 2048 无尽冲击更高分，越红线才结束'],
    ];
    rows.forEach((r, i) => {
      const y = 260 - i * 84;
      addLabel(p, r[0], -260, y, {
        fontSize: 24, bold: true, color: hex('#FFD24A'), width: 52,
      });
      addLabel(p, r[1], -216, y, {
        fontSize: 19, lineHeight: 26, height: 58, color: hex('#FFFFFF'), width: 452, align: Label.HorizontalAlign.LEFT, anchorX: 0,
      });
    });
    addButton(p, {
      x: 0, y: -330, width: 320, height: 80, text: '知道了', fontSize: 28, frame: this.assets.ui.button_gold!,
      onClick: () => this.cb.onTutorialDone(),
    });
    n.active = false;
    return n;
  }

  private buildLeaderboard(): Node {
    const H = this.height;
    const n = makeNode('Leaderboard', this.root, 0, 0, 750, H, 0, 0);
    this.addFullDim(n, 200);
    const panel = addPanel(n, this.assets.ui.panel_glass!, 375, this.centerY, 630, 790);
    const p = panel.node;
    addLabel(p, '高分排行榜', 0, 326, { fontSize: 44, bold: true, color: hex('#FFE08A') });
    addLabel(p, '本机历史巅峰战绩 · Top 5', 0, 276, { fontSize: 18, color: hex('#9FE9F2'), width: 420 });

    const badgeColors = ['#FFD24A', '#E2F3FF', '#FFA866', '#9FE9F2', '#9FE9F2'];
    for (let i = 0; i < 5; i++) {
      const y = 178 - i * 94;
      addPanel(p, this.assets.ui.panel_glass!, 0, y, 540, 78);
      const rank = addLabel(p, `#${i + 1}`, -228, y, {
        fontSize: 28,
        bold: true,
        width: 68,
        color: hex(badgeColors[i]),
        outline: hex('#063A50', 220),
        outlineWidth: 3,
      });
      const score = addLabel(p, '—', -172, y + 12, {
        fontSize: 28,
        bold: true,
        width: 240,
        align: Label.HorizontalAlign.LEFT,
        anchorX: 0,
        color: hex('#FFFFFF'),
        outline: hex('#063A50', 220),
        outlineWidth: 2,
      });
      const meta = addLabel(p, '虚位以待', -172, y - 18, {
        fontSize: 16,
        width: 390,
        align: Label.HorizontalAlign.LEFT,
        anchorX: 0,
        color: hex('#BFF8FF'),
      });
      this.rankRows.push({ rank, score, meta });
    }

    addButton(p, {
      x: 0, y: -312, width: 300, height: 74, text: '关闭', fontSize: 28, frame: this.assets.ui.button_gold!,
      onClick: () => this.cb.onCloseRank(),
    });
    n.active = false;
    return n;
  }

  private buildCelebration(): Node {
    const H = this.height;
    const n = makeNode('Celebration', this.root, 0, 0, 750, H, 0, 0);
    const flashNode = makeNode('flash', n, 0, 0, 750, H, 0, 0);
    this.celebrateFlash = flashNode.addComponent(Graphics);
    const ring = addSprite(n, this.assets.ui.gold_ring!, 375, H * 0.53, 300, 300);
    ring.node.addComponent(UIOpacity).opacity = 225;
    this.celebrateRing = ring;
    this.celebrateLabel = addLabel(n, '1024', 375, H * 0.55, {
      fontSize: 132, bold: true, width: 560, color: hex('#FFF3C0'), outline: hex('#8A4A00', 255), outlineWidth: 10, shadow: true,
    });
    this.celebrateSub = addLabel(n, '', 375, H * 0.55 - 118, {
      fontSize: 28, bold: true, width: 600, color: hex('#FFFFFF'), outline: hex('#5A2A00', 230), outlineWidth: 4,
    });
    n.active = false;
    return n;
  }

  private buildAd(): Node {
    const H = this.height;
    const n = makeNode('AdLoading', this.root, 0, 0, 750, H, 0, 0);
    this.addFullDim(n, 160);
    const panel = addPanel(n, this.assets.ui.panel_glass!, 375, this.centerY, 460, 220);
    addLabel(panel.node, '广告播放中…', 0, 34, { fontSize: 28, bold: true, color: hex('#FFE08A') });
    addLabel(panel.node, '正在获取广告内容', 0, -28, { fontSize: 17, color: hex('#9FE9F2') });
    n.active = false;
    return n;
  }

  // ------------------------------------------------------------------ 页面控制

  private bringToFront(node: Node): void {
    node.setSiblingIndex(this.root.children.length - 1);
  }

  showHome(best: number): void {
    this.hideAll();
    this.bringToFront(this.home);
    this.home.active = true;
    this.homeBest.string = formatNumber(best);
  }

  hideHome(): void {
    this.home.active = false;
  }

  setHomeBest(best: number): void {
    this.homeBest.string = formatNumber(best);
  }

  showSettings(sound: boolean, vibration: boolean, aimLine: boolean, debug: boolean): void {
    this.soundOn = sound;
    this.vibrationOn = vibration;
    this.aimLineOn = aimLine;
    this.debugOn = debug;
    setButtonLabel(this.soundBtn, `音效：${sound ? '开' : '关'}`);
    setButtonLabel(this.vibBtn, `震动：${vibration ? '开' : '关'}`);
    setButtonLabel(this.aimLineBtn, `瞄准虚线：${aimLine ? '开' : '关'}`);
    setButtonLabel(this.debugBtn, `调试面板：${debug ? '开' : '关'}`);
    this.debugBtn.active = debug;
    this.tuningBtn.active = debug;
    this.resetArmed = 0;
    setButtonLabel(this.resetBtn, '清空最高分');
    this.bringToFront(this.settings);
    this.settings.active = true;
  }

  hideSettings(): void {
    this.settings.active = false;
    this.resetArmed = 0;
    setButtonLabel(this.resetBtn, '清空最高分');
  }

  showPause(): void {
    this.bringToFront(this.pause);
    this.pause.active = true;
  }

  hidePause(): void {
    this.pause.active = false;
  }

  showResult(s: ResultSummary): void {
    this.clearToast();
    this.bringToFront(this.result);
    this.revive.active = false;
    this.result.active = true;
    const won = s.result.got1024 || s.result.got2048;
    this.resultTitle.string = s.result.got2048 ? '2048 终极达成' : won ? '1024 达成' : s.result.reason === 'line' ? '水位越线' : '时间到';
    this.resultTitle.color = won ? hex('#FFE08A') : hex('#FF9AA4');
    this.resultScore.string = formatNumber(s.score);
    this.resultBest.string = `最高分 ${formatNumber(s.best)}`;
    this.resultNew.node.active = s.newBest;
    const lines = [
      `合并 ${s.result.merges} 次    最高球 ${s.result.maxBall}`,
      `最高连击 ${s.result.maxCombo}    脱落 ${s.result.detached} 颗`,
      `存活 ${formatTime(s.result.time)}    深度 ×${(1 + s.depthStep * s.result.depth).toFixed(2)}`,
      s.result.revived ? '本局已复活 1 次' : '本局未复活',
    ];
    this.resultStats.string = lines.join('\n');
    this.setDoubled(s.doubled);
  }

  setDoubled(done: boolean): void {
    setButtonLabel(this.doubleBtn, done ? '已双倍 · 记录已保存' : '得分 ×2');
    setButtonEnabled(this.doubleBtn, !done);
  }

  hideResult(): void {
    this.result.active = false;
  }

  showRevive(score: number, seconds: number, drainSeconds = 3): void {
    this.bringToFront(this.revive);
    this.reviveDesc.string = `复活：自动排水 ${Math.max(2, Math.round(drainSeconds))} 秒`;
    this.reviveLeft = seconds;
    this.reviveScore.string = formatNumber(score);
    this.reviveCount.string = `${seconds} 秒后自动结算`;
    this.revive.active = true;
  }

  updateRevive(seconds: number): void {
    if (!this.revive.active) return;
    this.reviveLeft = seconds;
    this.reviveCount.string = seconds > 0 ? `${seconds} 秒后自动结算` : '即将结算…';
  }

  hideRevive(): void {
    this.revive.active = false;
  }

  showTutorial(): void {
    this.bringToFront(this.tutorial);
    this.tutorial.active = true;
  }

  hideTutorial(): void {
    this.tutorial.active = false;
  }

  showLeaderboard(records: ScoreRecord[]): void {
    for (let i = 0; i < this.rankRows.length; i++) {
      const row = this.rankRows[i];
      const rec = records[i];
      if (rec) {
        row.score.string = formatNumber(rec.score);
        row.score.color = i === 0 ? hex('#FFE08A') : hex('#FFFFFF');
        row.meta.string = `最高球 ${rec.maxBall}  ·  合并 ${rec.merges} 次  ·  存活 ${formatTime(rec.time)}`;
      } else {
        row.score.string = '—';
        row.score.color = hex('#9FE9F2', 140);
        row.meta.string = '虚位以待，开启新对局创造纪录';
      }
    }
    this.bringToFront(this.leaderboard);
    this.leaderboard.active = true;
  }

  hideLeaderboard(): void {
    this.leaderboard.active = false;
  }

  showCelebration(kind: 1024 | 2048): void {
    this.bringToFront(this.celebration);
    this.celebrateLabel.string = `${kind}`;
    this.celebrateSub.string = kind === 1024 ? '1024 达成！+5,000' : '2048 传说！+20,000';
    this.celebrateTimer = kind === 1024 ? 1.6 : 2.0;
    this.celebrateDuration = this.celebrateTimer;
    this.celebrateRing.node.setScale(0.6, 0.6, 1);
    this.celebrateLabel.node.setScale(0.5, 0.5, 1);
    this.celebration.active = true;
    this.paintFlash(0.55);
  }

  hideCelebration(): void {
    this.celebration.active = false;
    this.celebrateTimer = 0;
  }

  clearToast(): void {
    this.toastNode.active = false;
    this.toastTime = 0;
  }

  showAdLoading(v: boolean): void {
    if (v) this.bringToFront(this.adNode);
    this.adNode.active = v;
  }

  toast(msg: string, seconds = 1.8): void {
    const textNode = this.toastNode.getChildByName('toastText');
    const label = textNode?.getComponent(Label);
    if (label) label.string = msg;
    this.bringToFront(this.toastNode);
    this.toastNode.active = true;
    this.toastOp.opacity = 255;
    this.toastTime = seconds;
  }

  hideAll(): void {
    this.home.active = false;
    this.settings.active = false;
    this.pause.active = false;
    this.result.active = false;
    this.revive.active = false;
    this.tutorial.active = false;
    this.leaderboard.active = false;
    this.celebration.active = false;
    this.adNode.active = false;
    this.toastNode.active = false;
    this.toastTime = 0;
    this.celebrateTimer = 0;
  }

  update(dt: number): void {
    // 主页装饰球浮动与果冻呼吸
    if (this.home.active) {
      const t = Date.now() / 1000;
      for (const b of this.homeBalls) {
        const dy = Math.sin(t * 1.15 + b.phase) * b.amp;
        const dx = Math.cos(t * 0.7 + b.phase) * (b.amp * 0.35);
        b.node.setPosition(b.x + dx, b.y + dy, 0);
        const sc = 1 + Math.sin(t * 2.1 + b.phase) * 0.045;
        b.node.setScale(sc, 1 / sc, 1);
      }
    }
    if (this.resetArmed > 0) {
      this.resetArmed -= dt;
      if (this.resetArmed <= 0) setButtonLabel(this.resetBtn, '清空最高分');
    }
    if (this.toastTime > 0) {
      this.toastTime -= dt;
      if (this.toastTime < 0.5) this.toastOp.opacity = Math.round(255 * (this.toastTime / 0.5));
      if (this.toastTime <= 0) this.toastNode.active = false;
    }
    if (this.celebration.active && this.celebrateTimer > 0) {
      this.celebrateTimer -= dt;
      const t = 1 - Math.max(0, this.celebrateTimer) / this.celebrateDuration;
      const pop = Math.min(1, t * 5);
      this.celebrateLabel.node.setScale(0.5 + 0.55 * pop, 0.5 + 0.55 * pop, 1);
      const rs = 0.6 + t * 1.55;
      this.celebrateRing.node.setScale(rs, rs, 1);
      this.celebrateRing.node.angle += dt * 28;
      const alpha = Math.max(0, 1 - t) * 0.75;
      this.paintFlash(alpha);
      if (this.celebrateTimer <= 0) this.celebration.active = false;
    }
  }

  private paintFlash(alpha: number): void {
    const g = this.celebrateFlash;
    const W = this.screenWidth;
    g.clear();
    g.fillColor = hex('#FFD24A', Math.round(80 * alpha));
    g.rect(375 - W / 2, 0, W, this.height);
    g.fill();
  }
}
