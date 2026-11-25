/**
 * Liquid1024 · M2 对局编排
 *
 * 负责：主页/对局/暂停/设置/复活/结算状态机、触摸瞄准与力度取值、
 * 世界事件 -> 表现/音效/震动/计分、广告占位钩子、持久化。
 *
 * 规则本身全部在 core/BallWorld.ts；本文件不复制数值规则。
 */
import {
  Node,
  Sprite,
  UIOpacity,
  UITransform,
  Vec3,
  Game,
  game,
  sys,
  view,
} from 'cc';
import { BallWorld } from '../core/BallWorld';
import { BALL_COLORS, TANK, comboMultiplier } from '../core/Config';
import type { Tuning } from '../core/Config';
import type { ItemCounts, ItemKind, RunResult, WorldEvent } from '../core/Types';
import { AdService } from './AdService';
import type { RewardPlacement } from './AdService';
import { AssetHub } from './AssetHub';
import { AudioController } from './AudioController';
import { BoardView } from './BoardView';
import { Hud } from './Hud';
import { Menus } from './Menus';
import type { ResultSummary } from './Menus';
import {
  isDebugEnabled,
  loadSave,
  loadTuning,
  persistSave,
  persistTuning,
  recordScore,
  resetBest as resetSavedBest,
  setDebugEnabled,
} from './Storage';
import type { SaveData } from './Storage';
import { TuningPanel } from './TuningPanel';
import { addSprite, makeNode } from './UiKit';

type GameState =
  | 'boot'
  | 'home'
  | 'playing'
  | 'tutorial'
  | 'paused'
  | 'settings'
  | 'rank'
  | 'reviveOffer'
  | 'result'
  | 'debug';

const REVIVE_SECONDS = 8;
const ITEM_AD_CAP = 2;

export class GameApp {
  private readonly assets: AssetHub;
  private readonly audio: AudioController;
  private readonly ads = new AdService();
  private readonly world: BallWorld;
  private readonly board: BoardView;
  private readonly hud: Hud;
  private readonly menus: Menus;
  private readonly tuningPanel: TuningPanel;
  private readonly stage: Node;
  private readonly touchLayer: Node;
  private readonly dangerVignette: Sprite;
  private readonly bgDanger: Sprite;
  private readonly bgNormal!: Sprite;
  private readonly width = 750;
  private screenWidth = 750;
  private height: number;
  private safeTop = 0;
  private safeBottom = 0;
  private tankTop = 0;
  private state: GameState = 'boot';
  private stateBeforeSettings: GameState = 'home';
  private stateBeforeDebug: GameState = 'home';
  private save: SaveData;
  private tuning: Tuning;
  private items: ItemCounts = { drain: 3, melt: 3, magnet: 3 };
  private itemAdUses: ItemCounts = { drain: 0, melt: 0, magnet: 0 };
  private aimAdLeft = 2;
  private slowAdLeft = 1;
  private aimExtendedShot = false;
  private slowUsed = false;
  private doubleUsed = false;
  private reviveCountdown = 0;
  private tutorialFromHome = false;
  private adBusy = false;
  private lastResult: RunResult | null = null;
  private displayScore = 0;
  private bestAtStart = 0;
  private resultNewBest = false;
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragMoved = false;
  private aimCancelled = false;
  private aimAngle = 0;
  private chargePower = 42;
  private chargeFullNotified = false;
  private lastAnnounceTime = -10;
  private lastInterstitial = 0;
  private fpsTime = 0;
  private fpsFrames = 0;
  private debugOpen = false;

  constructor(host: Node, assets: AssetHub) {
    this.assets = assets;
    this.save = loadSave();
    this.tuning = loadTuning();
    this.audio = new AudioController(host, assets);
    this.audio.soundOn = this.save.sound;
    this.audio.vibrationOn = this.save.vibration;

    const vis = view.getVisibleSize();
    this.screenWidth = Math.max(750, Math.round(vis.width || 750));
    this.height = Math.max(1200, Math.round(vis.height || 1334));
    const safe = sys.getSafeAreaRect();
    this.safeTop = Math.max(0, Math.min(160, Math.round(this.height - (safe.y + safe.height))));
    this.safeBottom = Math.max(0, Math.min(100, Math.round(safe.y)));

    this.stage = makeNode('Stage', host, -375, -this.height / 2, this.width, this.height, 0, 0);

    // ---- 背景（覆盖手机窄高与 iPad 宽竖屏）
    const bgScale = Math.max(this.screenWidth / 750, this.height / 1334);
    const bgW = 750 * bgScale;
    const bgH = 1334 * bgScale;
    this.bgNormal = addSprite(this.stage, assets.bgNormal, 375, this.height / 2, bgW, bgH);
    this.bgDanger = addSprite(this.stage, assets.bgDanger, 375, this.height / 2, bgW, bgH);
    this.bgDanger.node.addComponent(UIOpacity).opacity = 0;

    // ---- 大水箱主视野布局：顶栏 104 / 底栏 132，最大化水箱面积
    const barBottom = 132 + this.safeBottom;
    const topBar = 104 + this.safeTop;
    const availH = this.height - barBottom - topBar - 6;
    const s = Math.min(726 / TANK.width, availH / TANK.height);
    const tankW = TANK.width * s;
    const tankH = TANK.height * s;
    const tankX = (this.width - tankW) / 2;
    const tankY = barBottom + Math.max(0, (availH - tankH) / 2);
    this.tankTop = tankY + tankH;

    this.world = new BallWorld({ tuning: this.tuning, listener: (e) => this.onWorldEvent(e) });
    this.board = new BoardView(this.stage, assets, this.world);
    this.board.setTankLayout(tankX, tankY, s);
    this.board.tank.active = false;

    // ---- 危险态暗角（全屏覆盖）
    this.dangerVignette = addSprite(this.stage, assets.ui.danger_vignette!, 375, this.height / 2, this.screenWidth, this.height);
    const dOp = this.dangerVignette.node.addComponent(UIOpacity);
    dOp.opacity = 0;

    // ---- 瞄准触摸层（在 HUD 之下、球场之上；全屏宽响应）
    this.touchLayer = makeNode('AimTouchLayer', this.stage, 375 - this.screenWidth / 2, 0, this.screenWidth, this.height, 0, 0);
    this.touchLayer.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
    this.touchLayer.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
    this.touchLayer.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
    this.touchLayer.on(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
    this.touchLayer.active = false;

    // ---- 极简纯净 HUD
    this.hud = new Hud(this.stage, assets, this.height, this.safeTop, this.safeBottom, {
      onPause: () => this.pause(),
      onItem: (kind) => this.useItem(kind),
      onSwap: () => this.swapBall(),
    });
    this.hud.setVisible(false);

    // ---- 全屏页面
    this.menus = new Menus(this.stage, assets, this.height, this.safeTop, this.safeBottom, {
      onStart: () => this.startRun(),
      onOpenSettings: () => this.openSettings(),
      onCloseSettings: () => this.closeSettings(),
      onToggleSound: () => this.toggleSound(),
      onToggleVibration: () => this.toggleVibration(),
      onToggleAimLine: () => this.toggleAimLine(),
      onToggleDebug: () => this.toggleDebug(),
      onOpenDebug: () => this.openDebug(),
      onResetBest: () => {
        this.save = resetSavedBest();
        this.menus.setHomeBest(this.save.best);
        this.menus.toast('最高分已清空');
      },
      onResume: () => this.resume(),
      onRestart: () => this.startRun(),
      onHome: () => this.goHome(),
      onRevive: () => this.buyRevive(),
      onGiveUp: () => this.showResult(),
      onDoubleScore: () => this.buyDoubleScore(),
      onTutorialDone: () => this.closeTutorial(),
      onOpenTutorial: () => this.openTutorialFromHome(),
      onOpenRank: () => this.openRank(),
      onCloseRank: () => this.closeRank(),
    }, this.screenWidth);
    this.menus.showHome(this.save.best);

    // ---- 调参面板
    this.tuningPanel = new TuningPanel(this.stage, assets, this.height, {
      onChange: (t) => {
        this.tuning = t;
        this.world.applyTuning(t);
        persistTuning(t);
      },
      onClose: () => this.closeDebug(),
      onDebug: (kind) => this.debugAction(kind),
      onToast: (msg) => this.menus.toast(msg),
    }, this.screenWidth);

    this.state = 'home';
    if (isDebugEnabled()) {
      const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
      g.__liquid = this;
    }
    // 切后台自动暂停，避免微信小游戏后台继续计时/排水
    game.on(Game.EVENT_HIDE, () => {
      if (this.state === 'playing') this.pause();
    });
    void this.ads.showBanner();
  }

  // ------------------------------------------------------------------ 主循环

  update(rawDt: number): void {
    const dt = Math.min(0.05, Math.max(0, rawDt));
    this.menus.update(dt);
    this.updateFps(dt);
    // 广告播放期间冻结对局与复活倒计时
    if (this.adBusy) return;

    if (this.state === 'reviveOffer') {
      this.reviveCountdown -= dt;
      this.menus.updateRevive(Math.max(0, Math.ceil(this.reviveCountdown)));
      if (this.reviveCountdown <= 0) this.showResult();
      return;
    }

    if (this.state !== 'playing' || this.adBusy) return;

    this.world.update(dt);
    if (this.dragging && !this.aimCancelled && this.world.current !== null && !this.world.isInputLocked()) {
      this.chargePower = Math.min(100, this.chargePower + dt * 95);
      if (this.chargePower >= 100 && !this.chargeFullNotified) {
        this.chargeFullNotified = true;
        this.audio.play('charge_max', 0.52);
        this.audio.vibrate('light');
        this.board.onChargeMax();
      }
    }
    this.board.setAim({
      aiming: this.world.current !== null && !this.world.isInputLocked(),
      charging: this.dragging && !this.aimCancelled,
      angle: this.aimAngle,
      power: this.dragging ? this.chargePower : 68,
      extended: true,
      showLine: this.save.aimLine,
      cancelled: this.aimCancelled,
      selecting: this.hud.selectingKind,
    });
    this.board.sync(dt);
    this.hud.update(dt);
    this.syncHud();
    this.updateDangerVisuals(dt);

    if (this.world.mode === 'defeated' && this.state === 'playing') {
      // 兜底：事件丢失时状态机也能收口
      this.showResult();
    }
  }

  private syncHud(): void {
    this.hud.setScore(this.world.score);
    this.hud.setBest(Math.max(this.save.best, this.world.score), this.world.score > this.save.best);
    this.hud.setNext(this.world.next ?? 0, this.world.nextWild);
    this.hud.setStreak(this.world.streak, this.world.isFever(), this.world.currentWild || this.world.nextWild);
    this.hud.setSwapAvailable(this.world.canSwap());
  }

  private updateDangerVisuals(dt: number): void {
    const line = this.world.lineY;
    const bottom = this.world.getMinBottom();
    const prox = Math.max(0, Math.min(1, 1 - (bottom - line) / 220));
    const danger = this.world.getDangerLevel();
    const pulse = 0.5 + 0.5 * Math.sin(this.world.worldTime * Math.PI * 2 * 1.2);
    const bgOp = Math.round(150 * prox);
    const bgNodeOp = this.bgDanger.node.getComponent(UIOpacity)!;
    if (bgNodeOp.opacity !== bgOp) bgNodeOp.opacity = bgOp;
    const dOp = this.dangerVignette.node.getComponent(UIOpacity)!;
    const vOp = Math.round(Math.min(190, 80 * prox + 105 * danger + 20 * pulse * prox));
    if (dOp.opacity !== vOp) dOp.opacity = vOp;
    if (prox > 0.55 || danger > 0.1) this.audio.danger(this.world.runTime);
    void dt;
  }

  private updateFps(dt: number): void {
    if (!this.debugOpen) return;
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.tuningPanel.setFps(this.fpsFrames / this.fpsTime);
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
  }

  // ------------------------------------------------------------------ 世界事件

  private onWorldEvent(ev: WorldEvent): void {
    switch (ev.type) {
      case 'loaded':
        this.hud.setNext(ev.next, this.world.nextWild);
        this.hud.setSwapAvailable(this.world.canSwap());
        if (this.world.currentWild) {
          this.audio.play('rainbow', 0.72);
          this.board.spawnWildLoaded();
          this.board.spawnText(TANK.width / 2, 720, '🌈 万能彩球已装填!', '#FFAEF8', 30);
          this.hud.showHint('🌈 万能彩球就绪！碰任意球直接升阶', 2.4);
        }
        break;
      case 'swap':
        this.board.onSwap();
        this.board.spawnText(TANK.muzzleX, TANK.muzzleY + 42, '⇄ 换球', '#8FF0D8', 22);
        this.audio.play('swap', 0.55);
        this.audio.vibrate('light');
        this.hud.setSwapAvailable(false);
        this.hud.setNext(this.world.next ?? 0, this.world.nextWild);
        break;
      case 'fire':
        this.audio.play('shoot', ev.power >= 85 ? 0.68 : 0.5);
        this.audio.vibrate(ev.power >= 85 ? 'medium' : 'light');
        this.board.onFire(ev.power);
        this.hud.setSwapAvailable(false);
        break;
      case 'bounce':
        this.board.spawnBounce(ev.x, ev.y, ev.wall);
        this.audio.play('bounce', 0.42);
        break;
      case 'collide':
        this.board.onCollide(ev.aId, ev.bId, ev.nx, ev.ny, ev.speed);
        break;
      case 'stick':
        this.board.onStick(ev.ball.x, ev.ball.y, ev.power);
        break;
      case 'merge':
        this.board.spawnMerge(ev.x, ev.y, ev.value, ev.combo, ev.score, false);
        this.hud.showCombo(
          ev.combo,
          ev.score,
          comboMultiplier(ev.combo, this.world.tuning),
        );
        this.audio.playMerge(ev.combo, 0.72);
        this.maybeAnnounce(ev.combo, ev.streak ?? 0);
        this.audio.vibrate(ev.value >= 256 ? 'medium' : 'light');
        break;
      case 'tier':
        this.board.spawnText(ev.x, ev.y + 44, `新合成 ${ev.value}!`, BALL_COLORS[ev.value] ?? '#FFE08A', 28);
        if (ev.value >= 128) this.awardMilestoneItem(ev.value);
        break;
      case 'wildReady':
        this.audio.play('rainbow', 0.7);
        this.board.spawnText(TANK.muzzleX, 200, '获得万能彩球!', '#FF9FF3', 28);
        this.hud.setNext(this.world.next ?? 0, this.world.nextWild);
        break;
      case 'iceBreak':
        this.board.spawnIceBreak(ev.x, ev.y);
        this.audio.play('bounce', 0.65);
        this.audio.vibrate('light');
        break;
      case 'vortex':
        if (ev.active) {
          this.audio.play('rainbow', 0.5);
          this.board.spawnText(ev.cx, ev.cy - 40, '暗流涌动 · 聚拢!', '#7CF7FF', 26);
        }
        break;
      case 'streak':
        this.hud.setStreak(ev.streak, ev.fever, this.world.currentWild || this.world.nextWild);
        if (ev.fever && ev.streak === 3) {
          this.board.spawnText(TANK.width / 2, 560, '沸腾状态! +20%', '#FFE066', 30);
          this.maybeAnnounce(0, ev.streak);
        }
        break;
      case 'tide':
        this.board.onTide(ev.wave);
        this.audio.play('drop', 0.55);
        this.hud.showHint(`🌊 第 ${ev.wave} 波潮汐！快连消清场`, 1.8);
        break;
      case 'drop': {
        let sumX = 0;
        let sumY = 0;
        for (const id of ev.ids) {
          const b = this.world.balls.find((x) => x.id === id);
          if (b) {
            this.board.spawnDrop(b.x, b.y);
            sumX += b.x;
            sumY += b.y;
          }
        }
        if (ev.count > 0) {
          const cx = sumX > 0 ? sumX / ev.count : TANK.width / 2;
          const cy = sumY > 0 ? sumY / ev.count : 620;
          this.board.spawnText(cx, cy, `脱落 ×${ev.count} +${ev.score}!`, '#8FE6F7', 27);
        }
        this.audio.play('drop', 0.55);
        break;
      }
      case 'first1024':
        this.board.spawnGold(ev.x, ev.y);
        this.audio.play('win', 0.8);
        this.audio.playAnnounce('legend', 0.9);
        this.awardMilestoneItem(1024);
        this.audio.vibrate('heavy');
        this.menus.showCelebration(1024);
        break;
      case 'first2048':
        this.board.spawnGold(ev.x, ev.y);
        this.audio.play('win', 1);
        this.audio.playAnnounce('legend', 1.0);
        this.audio.vibrate('heavy');
        this.menus.showCelebration(2048);
        break;
      case 'celebrateEnd':
        break;
      case 'phase':
      case 'depth':
        break;
      case 'defeat':
        this.onDefeat(ev.reason);
        break;
      case 'result':
        this.lastResult = ev.result;
        this.finishRunFlow(ev.result);
        break;
      case 'reviveStart':
        this.state = 'playing';
        this.menus.hideRevive();
        this.menus.toast('复活成功 · 排水 3 秒');
        break;
      case 'reviveEnd':
        this.state = 'playing';
        this.touchLayer.active = true;
        this.hud.setPauseEnabled(true);
        break;
      case 'item':
        break;
      default:
        break;
    }
  }

  private onDefeat(reason: 'line' | 'hardcap'): void {
    if (this.state !== 'playing') return;
    this.dragging = false;
    this.audio.vibrate('heavy');
    this.audio.play('danger', 0.7);
    // 12:00 硬上限不再提供复活，结算页标题会显示“时间到”，不额外弹 toast
    void reason;
  }

  private finishRunFlow(result: RunResult): void {
    this.lastResult = result;
    if (result.reason === 'line' && !this.world.reviveUsed && this.state === 'playing') {
      this.state = 'reviveOffer';
      this.reviveCountdown = REVIVE_SECONDS;
      this.touchLayer.active = false;
      this.hud.setPauseEnabled(false);
      this.menus.showRevive(result.score, REVIVE_SECONDS, this.world.tuning.reviveSeconds);
      return;
    }
    this.showResult();
  }

  // ------------------------------------------------------------------ 流程

  startRun(): void {
    if (this.adBusy) return;
    this.menus.hideAll();
    this.menus.hideHome();
    this.hud.setVisible(true);
    this.hud.reset();
    this.board.tank.active = true;
    this.state = 'playing';
    this.items = { drain: 3, melt: 3, magnet: 3 };
    this.itemAdUses = { drain: 0, melt: 0, magnet: 0 };
    this.aimAdLeft = 2;
    this.slowAdLeft = 1;
    this.aimExtendedShot = false;
    this.slowUsed = false;
    this.doubleUsed = false;
    this.bestAtStart = this.save.best;
    this.resultNewBest = false;
    this.displayScore = 0;
    this.lastResult = null;
    this.dragging = false;
    this.aimAngle = 0;
    this.lastAnnounceTime = -10;
    this.reviveCountdown = 0;
    this.touchLayer.active = true;
    this.hud.setPauseEnabled(true);
    this.hud.setItems(this.items);
    this.hud.setSelecting(null);
    this.bgDanger.node.getComponent(UIOpacity)!.opacity = 0;
    this.dangerVignette.node.getComponent(UIOpacity)!.opacity = 0;
    this.world.applyTuning(this.tuning);
    this.world.startRun();
    this.board.setWorld(this.world);
    this.board.setAim({ aiming: true, angle: 0, power: 100, extended: true, showLine: this.save.aimLine, selecting: null });
    this.hud.setWorld(this.world);
    this.board.sync(0);
    this.syncHud();
    this.audio.resetDanger();
    this.audio.play('click', 0.4);
    void this.ads.hideBanner();

    if (!this.save.tutorialSeen) {
      this.tutorialFromHome = false;
      this.state = 'tutorial';
      this.touchLayer.active = false;
      this.menus.showTutorial();
    }
  }

  private pause(): void {
    if (this.state !== 'playing' || this.adBusy) return;
    if (this.world.isInputLocked()) {
      this.menus.toast('演出中，稍等一下');
      return;
    }
    this.state = 'paused';
    this.dragging = false;
    this.touchLayer.active = false;
    this.hud.setPauseEnabled(false);
    this.menus.showPause();
    this.audio.play('click', 0.35);
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.menus.hidePause();
    this.touchLayer.active = true;
    this.hud.setPauseEnabled(true);
    this.audio.play('click', 0.35);
  }

  private goHome(): void {
    if (this.adBusy) return;
    this.state = 'home';
    this.dragging = false;
    this.touchLayer.active = false;
    this.hud.setVisible(false);
    this.board.tank.active = false;
    this.menus.hideAll();
    this.menus.showHome(this.save.best);
    this.bgDanger.node.getComponent(UIOpacity)!.opacity = 0;
    this.dangerVignette.node.getComponent(UIOpacity)!.opacity = 0;
    this.hud.setPauseEnabled(true);
    void this.ads.showBanner();
  }

  private openSettings(): void {
    this.stateBeforeSettings = this.state;
    this.state = 'settings';
    this.menus.showSettings(this.save.sound, this.save.vibration, this.save.aimLine, isDebugEnabled());
    this.audio.play('click', 0.35);
  }

  private closeSettings(): void {
    this.menus.hideSettings();
    this.state = this.stateBeforeSettings;
    if (this.state === 'home') this.menus.showHome(this.save.best);
    else if (this.state === 'playing') this.updateAim();
    this.audio.play('click', 0.35);
  }

  private toggleSound(): boolean {
    this.save.sound = !this.save.sound;
    this.audio.soundOn = this.save.sound;
    if (this.save.sound) this.audio.play('click', 0.4);
    persistSave(this.save);
    return this.save.sound;
  }

  private toggleVibration(): boolean {
    this.save.vibration = !this.save.vibration;
    this.audio.vibrationOn = this.save.vibration;
    if (this.save.vibration) this.audio.vibrate('light');
    persistSave(this.save);
    return this.save.vibration;
  }

  private toggleAimLine(): boolean {
    this.save.aimLine = !this.save.aimLine;
    if (this.save.sound) this.audio.play('click', 0.4);
    persistSave(this.save);
    this.updateAim();
    return this.save.aimLine;
  }

  private toggleDebug(): boolean {
    const on = !isDebugEnabled();
    setDebugEnabled(on);
    if (!on && this.debugOpen) this.closeDebug();
    return on;
  }

  private openTutorialFromHome(): void {
    this.tutorialFromHome = true;
    this.state = 'tutorial';
    this.menus.showTutorial();
  }

  private openRank(): void {
    this.state = 'rank';
    this.menus.showLeaderboard(this.save.records);
    this.audio.play('click', 0.35);
  }

  private closeRank(): void {
    this.menus.hideLeaderboard();
    this.state = 'home';
    this.menus.showHome(this.save.best);
    this.audio.play('click', 0.35);
  }

  private closeTutorial(): void {
    this.menus.hideTutorial();
    if (this.tutorialFromHome) {
      this.state = 'home';
      this.menus.showHome(this.save.best);
      return;
    }
    this.state = 'playing';
    this.touchLayer.active = true;
    if (!this.save.tutorialSeen) {
      this.save.tutorialSeen = true;
      persistSave(this.save);
    }
  }

  private showResult(): void {
    if (!this.lastResult) return;
    this.state = 'result';
    this.dragging = false;
    this.touchLayer.active = false;
    this.hud.setVisible(false);
    this.menus.hideRevive();
    this.menus.hidePause();
    this.menus.hideTutorial();
    this.menus.hideCelebration();
    this.displayScore = this.lastResult.score;
    this.resultNewBest = this.lastResult.score > this.bestAtStart;
    this.save = recordScore(
      this.displayScore,
      this.lastResult.maxBall,
      this.lastResult.merges,
      this.lastResult.time,
    );
    this.save.runs += 1;
    persistSave(this.save);
    const summary: ResultSummary = {
      result: this.lastResult,
      score: this.displayScore,
      best: this.save.best,
      newBest: this.resultNewBest,
      doubled: this.doubleUsed,
      depthStep: this.world.tuning.depthStep,
    };
    this.menus.showResult(summary);
    this.audio.play(this.lastResult.got1024 ? 'win' : 'click', 0.7);
    void this.ads.showBanner();
    // 插屏钩子：第 2 局起、结算间歇、≥60s
    if (this.save.runs >= 2 && Date.now() - this.lastInterstitial > 60000) {
      this.lastInterstitial = Date.now();
      void this.ads.showInterstitial();
    }
  }

  // ------------------------------------------------------------------ 广告 / 复活

  private async withRewarded(placement: RewardPlacement, onOk: () => void): Promise<void> {
    if (this.adBusy) return;
    this.adBusy = true;
    this.menus.showAdLoading(true);
    this.audio.play('click', 0.3);
    try {
      const res = await this.ads.showRewarded(placement);
      if (res.ok) onOk();
      else this.menus.toast(res.reason === 'closed' ? '广告未看完，未发放奖励' : '广告暂不可用');
    } finally {
      this.adBusy = false;
      this.menus.showAdLoading(false);
    }
  }

  private buyRevive(): void {
    if (this.state !== 'reviveOffer') return;
    void this.withRewarded('revive', () => {
      if (this.state !== 'reviveOffer') return;
      if (this.world.revive()) {
        this.menus.hideRevive();
        this.state = 'playing';
        this.touchLayer.active = true;
        this.hud.setPauseEnabled(true);
        this.reviveCountdown = 0;
      } else {
        this.menus.toast('本局已复活过');
      }
    });
  }

  private buyDoubleScore(): void {
    if (this.state !== 'result' || this.doubleUsed || !this.lastResult) return;
    void this.withRewarded('doubleScore', () => {
      if (this.state !== 'result' || this.doubleUsed) return;
      this.doubleUsed = true;
      this.displayScore *= 2;
      this.resultNewBest = this.displayScore > this.bestAtStart;
      this.save = recordScore(
        this.displayScore,
        this.lastResult!.maxBall,
        this.lastResult!.merges,
        this.lastResult!.time,
      );
      this.menus.showResult({
        result: this.lastResult!,
        score: this.displayScore,
        best: this.save.best,
        newBest: this.resultNewBest,
        doubled: true,
        depthStep: this.world.tuning.depthStep,
      });
      this.audio.play('win', 0.6);
    });
  }

  private buyAimExtend(): void {
    void this.aimAdLeft;
  }

  private buySlowPower(): void {
    void this.slowAdLeft;
    void this.slowUsed;
    void this.aimExtendedShot;
  }

  // ------------------------------------------------------------------ 道具

  private useItem(kind: ItemKind): void {
    if (this.state !== 'playing' || this.adBusy) return;
    if (this.items[kind] <= 0) {
      this.offerItemSupply(kind);
      return;
    }
    if (kind === 'drain') {
      if (!this.world.canUseItem()) {
        this.menus.toast('刚发射/钻缝中，稍等一下');
        return;
      }
      const removed = this.world.useDrain();
      if (removed > 0) {
        this.items.drain--;
        this.hud.setItems(this.items);
        this.audio.play('drop', 0.55);
        this.hud.showHint(`排水 ${removed} 颗`, 1.2);
      }
      return;
    }
    // 融化/磁铁进入选球态
    if (this.hud.selectingKind === kind) {
      this.hud.setSelecting(null);
      return;
    }
    if (!this.world.canUseItem()) {
      this.menus.toast('刚发射/钻缝中，稍等一下');
      return;
    }
    this.hud.setSelecting(kind);
    this.dragging = false;
  }

  private offerItemSupply(kind: ItemKind): void {
    if (this.itemAdUses[kind] >= ITEM_AD_CAP) {
      this.menus.toast('本局该道具补给已用完');
      return;
    }
    if (this.items[kind] >= 5) {
      this.menus.toast('持有上限 5 个');
      return;
    }
    void this.withRewarded('itemSupply', () => {
      if (this.state !== 'playing' || this.items[kind] >= 5) return;
      this.items[kind]++;
      this.itemAdUses[kind]++;
      this.hud.setItems(this.items);
      this.menus.toast('道具 +1');
    });
  }

  private applySelectingAt(tankX: number, tankY: number): void {
    const kind = this.hud.selectingKind;
    if (!kind) return;
    const ball = this.world.ballAt(tankX, tankY);
    if (!ball) {
      this.hud.showHint('点在一颗球上');
      return;
    }
    if (kind === 'melt') {
      if (this.world.useMelt(ball.id)) {
        this.items.melt--;
        this.audio.play('drop', 0.5);
        this.hud.setItems(this.items);
        this.hud.setSelecting(null);
      } else {
        this.menus.toast('这颗球现在不能融化');
      }
    } else if (kind === 'magnet') {
      const removed = this.world.useMagnet(ball.id);
      if (removed > 0) {
        this.items.magnet--;
        this.audio.play('drop', 0.6);
        this.hud.setItems(this.items);
        this.hud.setSelecting(null);
        this.hud.showHint(`磁铁吸走 ${removed} 颗`, 1.4);
      } else {
        this.menus.toast('这颗球现在不能吸');
      }
    }
  }

  private swapBall(): void {
    if (this.state !== 'playing' || this.adBusy || this.world.isInputLocked()) return;
    if (this.hud.selectingKind) {
      this.hud.setSelecting(null);
      return;
    }
    if (!this.world.swapCurrentNext()) {
      if (this.world.current === this.world.next) {
        this.hud.showHint('两颗数字相同，无需交换', 1.1);
      } else {
        this.hud.showHint('本发已换过球，发射后再换', 1.2);
      }
    }
  }

  // ------------------------------------------------------------------ 触摸瞄准

  private onTouchStart(e: any): void {
    if (this.state !== 'playing' || this.adBusy || this.world.isInputLocked()) return;
    const local = this.toTank(e);
    if (!this.inPlayArea(local)) return;
    if (this.hud.selectingKind) {
      this.applySelectingAt(local.x, local.y);
      return;
    }
    if (this.world.current === null) return;
    this.dragging = true;
    this.dragStartX = local.x;
    this.dragStartY = local.y;
    this.dragMoved = false;
    this.aimCancelled = false;
    this.chargePower = 42;
    this.chargeFullNotified = false;
    // 点在炮台区域先不改变角度，拖动超过 18px 才进入瞄准，松手未拖则换球
    if (Math.hypot(local.x - TANK.turretX, local.y - TANK.turretY) >= 88) {
      this.aimAngle = this.angleTo(local);
    }
    this.updateAim();
  }

  private onTouchMove(e: any): void {
    if (!this.dragging || this.state !== 'playing' || this.adBusy) return;
    const local = this.toTank(e);
    if (!this.inPlayArea(local)) return;
    if (Math.hypot(local.x - this.dragStartX, local.y - this.dragStartY) > 18) {
      this.dragMoved = true;
    }
    if (this.dragMoved && local.y < 92) {
      if (!this.aimCancelled) {
        this.aimCancelled = true;
        this.chargePower = 42;
        this.chargeFullNotified = false;
        this.hud.showHint('已取消蓄力 · 上滑重蓄 / 松手放弃', 1.1);
      }
      this.updateAim();
      return;
    }
    this.aimCancelled = false;
    if (local.y >= 110 || this.dragMoved) {
      this.aimAngle = this.angleTo(local);
    }
    this.updateAim();
  }

  private onTouchCancel(): void {
    this.dragging = false;
    this.aimCancelled = false;
    this.chargePower = 42;
    this.chargeFullNotified = false;
    this.updateAim();
  }

  private onTouchEnd(e: any): void {
    if (!this.dragging) return;
    this.dragging = false;
    const local = this.toTank(e);
    if (this.state !== 'playing' || this.adBusy) return;
    const startedOnTurret = Math.hypot(this.dragStartX - TANK.turretX, this.dragStartY - TANK.turretY) < 88;
    if (startedOnTurret && !this.dragMoved) {
      this.aimCancelled = false;
      this.chargePower = 42;
      this.updateAim();
      this.swapBall();
      return;
    }
    if (this.aimCancelled || (this.dragMoved && local.y < 92)) {
      this.aimCancelled = false;
      this.chargePower = 42;
      this.chargeFullNotified = false;
      this.updateAim();
      return;
    }
    if (local.y >= 110) {
      this.aimAngle = this.angleTo(local);
    }
    this.aimCancelled = false;
    const firePower = this.chargePower;
    this.chargePower = 42;
    this.chargeFullNotified = false;
    this.updateAim();
    const ok = this.world.fire(this.aimAngle, firePower);
    if (ok) {
      this.lastResult = null;
    }
  }

  private maybeAnnounce(combo: number, streak: number): void {
    const t = this.world.worldTime;
    if (t - this.lastAnnounceTime < 1.4) return;
    if (combo >= 5 || streak >= 7) {
      this.lastAnnounceTime = t;
      this.audio.playAnnounce('legend', 0.92);
      this.board.spawnText(TANK.width / 2, 815, 'LEGENDARY!', '#FFE066', 34);
    } else if (combo >= 4 || streak >= 5) {
      this.lastAnnounceTime = t;
      this.audio.playAnnounce('unstoppable', 0.9);
      this.board.spawnText(TANK.width / 2, 810, 'UNSTOPPABLE!', '#FF9FF3', 32);
    } else if (combo === 3 || streak === 3) {
      this.lastAnnounceTime = t;
      this.audio.playAnnounce('amazing', 0.85);
      this.board.spawnText(TANK.width / 2, 805, 'AMAZING!', '#8FFFD4', 30);
    } else if (combo === 2) {
      this.lastAnnounceTime = t;
      this.audio.playAnnounce('great', 0.82);
      this.board.spawnText(TANK.width / 2, 800, 'GREAT!', '#9AF8FF', 28);
    }
  }

  private awardMilestoneItem(tierValue: number): void {
    const order: ItemKind[] = ['drain', 'melt', 'magnet'];
    const idx = Math.max(0, Math.round(Math.log2(tierValue)) - 7);
    const pick = order[idx % order.length];
    if (this.items[pick] < 5) {
      this.items[pick]++;
      this.hud.setItems(this.items);
      const name = pick === 'drain' ? '排水' : pick === 'melt' ? '融化' : '磁铁';
      this.board.spawnText(TANK.width / 2, 740, `解锁 ${tierValue} · ${name} +1!`, '#FFE08A', 26);
    }
  }

  private updateAim(): void {
    this.board.setAim({
      aiming: this.world.current !== null && !this.world.isInputLocked(),
      charging: this.dragging && !this.aimCancelled,
      angle: this.aimAngle,
      power: this.dragging ? this.chargePower : 68,
      extended: true,
      showLine: this.save.aimLine,
      cancelled: this.aimCancelled,
      selecting: this.hud.selectingKind,
    });
  }

  private toTank(e: any): Vec3 {
    const ui = e.getUILocation();
    const ut = this.board.tank.getComponent(UITransform)!;
    return ut.convertToNodeSpaceAR(new Vec3(ui.x, ui.y, 0));
  }

  /** 只接受球场内（含少量边缘）的瞄准起点，避免点 HUD 误发射 */
  private inPlayArea(local: Vec3): boolean {
    return local.x >= -10 && local.x <= TANK.width + 10 && local.y >= -8 && local.y <= TANK.height + 10;
  }

  private angleTo(local: Vec3): number {
    const dx = local.x - TANK.muzzleX;
    const dy = local.y - TANK.muzzleY;
    let a = (Math.atan2(dx, dy) * 180) / Math.PI;
    const half = this.world.getAimFanDeg() / 2;
    a = Math.max(-half, Math.min(half, a));
    return a;
  }

  // ------------------------------------------------------------------ 调参面板

  private openDebug(): void {
    if (!isDebugEnabled()) {
      this.menus.toast('调试面板已在设置中关闭');
      return;
    }
    this.stateBeforeDebug = this.state;
    this.state = 'debug';
    this.debugOpen = true;
    this.dragging = false;
    this.touchLayer.active = false;
    this.tuningPanel.open(this.tuning);
    this.tuningPanel.root.setSiblingIndex(this.stage.children.length - 1);
    this.audio.play('click', 0.35);
  }

  private closeDebug(): void {
    this.debugOpen = false;
    this.tuningPanel.close();
    this.state = this.stateBeforeDebug;
    if (this.state === 'playing') this.touchLayer.active = true;
    if (this.state === 'home') this.menus.showHome(this.save.best);
  }

  private debugAction(kind: 'fill' | 'first1024' | 'score' | 'clear'): void {
    if (this.state === 'home' || this.world.mode === 'idle') {
      this.menus.toast('先开始一局再压测');
      return;
    }
    if (kind === 'fill') {
      const vals = [2, 4, 8, 16, 32, 64];
      for (let i = 0; i < 20; i++) {
        const v = vals[Math.floor(Math.random() * vals.length)];
        this.world.debugAddBall(v, 40 + Math.random() * 580, 780 + Math.random() * 170, true);
      }
      this.menus.toast('已加入 20 颗压力球');
    } else if (kind === 'first1024') {
      this.world.debugFirst1024();
      this.menus.toast('已触发 1024 演出');
    } else if (kind === 'score') {
      this.world.debugScore(10000);
      this.menus.toast('分数 +10000');
    } else {
      this.world.debugClear();
      this.menus.toast('已清场');
    }
    this.syncHud();
  }
}
