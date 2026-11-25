/**
 * 球场渲染层（背景/水箱气泡/球堆软体果冻/警戒线/特效/漂浮数字/弹道/旋转水炮显式分层）
 *
 * 性能约定（D3）：
 * - 球节点只创建一次，之后复用，200+ 球不产生 GC 抖动；
 * - 11 级球共用一张 1024×960 图集，全部球 1 个 draw call；
 * - 水花粒子/涟漪/气泡/轨迹集中在一个 Graphics，空闲或超阈值自动降载；
 * - 漂浮提示文本使用固定 12 个节点对象池，零运行时分配。
 */
import {
  Color,
  Graphics,
  Label,
  Node,
  Sprite,
  UIOpacity,
  UITransform,
} from 'cc';
import { BALL_COLOR_RGB, BALL_COLORS, RADIUS, TANK } from '../core/Config';
import type { BallWorld } from '../core/BallWorld';
import type { ItemKind, WallSide } from '../core/Types';
import type { AssetHub } from './AssetHub';
import { addGraphics, addLabel, hex, makeNode } from './UiKit';

interface BallView {
  id: number;
  value: number;
  r: number;
  displayScale: number;
  wobblePhase: number;
  node: Node;
  sprite: Sprite;
  opacity: UIOpacity;
  seen: number;
  lastX: number;
  lastY: number;
  lastOpacity: number;
  // 软体弹簧形变状态
  ox: number;
  oy: number;
  ovx: number;
  ovy: number;
  sqAmp: number;
  sqTime: number;
  sqAngle: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  r: number;
  color: Color;
  stretch?: boolean;
}

interface Ring {
  x: number;
  y: number;
  r: number;
  vr: number;
  life: number;
  maxLife: number;
  color: Color;
  width: number;
}

interface AmbientBubble {
  x: number;
  y: number;
  r: number;
  vy: number;
  phase: number;
  alpha: number;
}

interface PopText {
  node: Node;
  label: Label;
  opacity: UIOpacity;
  active: boolean;
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  baseScale: number;
}

export interface AimView {
  aiming: boolean;
  charging?: boolean;
  angle: number;
  power: number;
  extended: boolean;
  showLine?: boolean;
  cancelled?: boolean;
  selecting?: ItemKind | null;
}

export class BoardView {
  readonly tank: Node;
  readonly stackLayer: Node;
  readonly fxLayer: Node;
  readonly aimLayer: Node;
  readonly turretLayer: Node;
  readonly shotLayer: Node;
  readonly lineLayer: Node;

  private world: BallWorld;
  private baseTankX = 0;
  private baseTankY = 0;
  private shakeAmp = 0;
  private shakeTime = 0;

  private ambientG: Graphics;
  private fxG: Graphics;
  private aimG: Graphics;
  private lineG: Graphics;
  private muzzleG: Graphics;
  private lineLabel: Label;
  private aimBadge: Label;
  private aimBadgeOp: UIOpacity;
  private aimTipNode: Node;
  private aimTipSprite: Sprite;
  private aimTipOp: UIOpacity;

  private views = new Map<number, BallView>();
  private pool: BallView[] = [];
  private popTexts: PopText[] = [];
  private frame = 0;
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private bubbles: AmbientBubble[] = [];
  private shotTrail: { x: number; y: number }[] = [];
  private fxDirty = false;
  private tmpColor = new Color();

  private shotSprite!: Sprite;
  private shotNode!: Node;
  private loadedNode!: Node;
  private loadedSprite!: Sprite;
  private turretNode!: Node;
  private turretSprite!: Sprite;
  private barrelNode!: Node;
  private barrelSprite!: Sprite;
  private turretState: 'idle' | 'charge' | 'fire' = 'idle';
  private fireTimer = 0;
  private swapTimer = 0;
  private turretFacing = 1;
  private turretSq = 0;
  private turretSqVel = 0;
  private chargeBubbleTimer = 0;
  private aim: AimView = { aiming: false, angle: 0, power: 0, extended: false };
  private lastLineY = -1;
  private lastDanger = -1;
  private aimWasVisible = false;
  private surfaceRipple = 0;

  constructor(parent: Node, private assets: AssetHub, world: BallWorld) {
    this.world = world;
    this.tank = makeNode('TankLayer', parent, 0, 0, TANK.width, TANK.height, 0, 0);

    // ---- 缸体底光/玻璃边（立体弧形玻璃水箱）
    const glass = addGraphics(this.tank, 0, 0, TANK.width, TANK.height);
    glass.fillColor = hex('#042F44', 28);
    glass.roundRect(0, 0, TANK.width, TANK.height, 34);
    glass.fill();
    // 两侧弧形玻璃高光带
    glass.fillColor = hex('#B8FAFF', 18);
    glass.roundRect(6, 26, 10, TANK.height - 52, 5);
    glass.fill();
    glass.roundRect(TANK.width - 16, 26, 10, TANK.height - 52, 5);
    glass.fill();
    glass.strokeColor = hex('#C8FAFF', 96);
    glass.lineWidth = 3.2;
    glass.roundRect(1.5, 1.5, TANK.width - 3, TANK.height - 3, 34);
    glass.stroke();
    // 顶部张力框基座
    glass.strokeColor = hex('#8FF6FF', 135);
    glass.lineWidth = 4;
    glass.moveTo(18, TANK.topY - 3);
    glass.lineTo(TANK.width - 18, TANK.topY - 3);
    glass.stroke();

    // ---- 水箱环境气泡/水面波纹层
    this.ambientG = addGraphics(this.tank, 0, 0, TANK.width, TANK.height);
    for (let i = 0; i < 24; i++) {
      this.bubbles.push({
        x: 28 + Math.random() * (TANK.width - 56),
        y: Math.random() * TANK.height,
        r: 2.2 + Math.random() * 5.2,
        vy: 26 + Math.random() * 44,
        phase: Math.random() * Math.PI * 2,
        alpha: 34 + Math.random() * 68,
      });
    }

    // ---- 球堆层
    this.stackLayer = makeNode('StackLayer', this.tank, 0, 0, TANK.width, TANK.height, 0, 0);

    // ---- 警戒线层
    this.lineLayer = makeNode('LineLayer', this.tank, 0, 0, TANK.width, TANK.height, 0, 0);
    this.lineG = addGraphics(this.lineLayer, 0, 0, TANK.width, TANK.height);
    this.lineLabel = addLabel(this.lineLayer, '警戒线', 26, TANK.lineY + 14, {
      fontSize: 17,
      bold: true,
      color: hex('#FF7886', 230),
      outline: hex('#3A0710', 210),
      outlineWidth: 2,
      width: 120,
      align: Label.HorizontalAlign.LEFT,
      anchorX: 0,
    });
    this.lineLabel.node.active = false;

    // ---- 特效层（粒子/涟漪 + 漂浮分数字体池）
    this.fxLayer = makeNode('FxLayer', this.tank, 0, 0, TANK.width, TANK.height, 0, 0);
    this.fxG = addGraphics(this.fxLayer, 0, 0, TANK.width, TANK.height);
    for (let i = 0; i < 12; i++) {
      const lbl = addLabel(this.fxLayer, '', 0, 0, {
        fontSize: 26,
        bold: true,
        color: hex('#FFFFFF'),
        outline: hex('#05354B', 240),
        outlineWidth: 4,
        width: 220,
      });
      const op = lbl.node.addComponent(UIOpacity);
      op.opacity = 0;
      lbl.node.active = false;
      this.popTexts.push({
        node: lbl.node,
        label: lbl,
        opacity: op,
        active: false,
        x: 0,
        y: 0,
        vy: 56,
        life: 0,
        maxLife: 0.85,
        baseScale: 1,
      });
    }

    // ---- 弹道层
    this.aimLayer = makeNode('AimLayer', this.tank, 0, 0, TANK.width, TANK.height, 0, 0);
    this.aimG = addGraphics(this.aimLayer, 0, 0, TANK.width, TANK.height);
    this.aimTipNode = makeNode('AimTipBall', this.aimLayer, 0, 0, 48, 48);
    this.aimTipSprite = this.aimTipNode.addComponent(Sprite);
    this.aimTipSprite.sizeMode = Sprite.SizeMode.CUSTOM;
    this.aimTipOp = this.aimTipNode.addComponent(UIOpacity);
    this.aimTipNode.active = false;
    this.aimBadge = addLabel(this.aimLayer, '', 0, 0, {
      fontSize: 19,
      bold: true,
      color: hex('#FFF2A6'),
      outline: hex('#05354B', 240),
      outlineWidth: 4,
      width: 150,
    });
    this.aimBadgeOp = this.aimBadge.node.addComponent(UIOpacity);
    this.aimBadge.node.active = false;

    // ---- 炮台层（底座史莱姆 + 围绕炮口中心旋转对齐虚线的金色炮管）
    this.turretLayer = makeNode('TurretLayer', this.tank, 0, 0, TANK.width, TANK.height, 0, 0);
    this.turretNode = makeNode('Turret', this.turretLayer, TANK.turretX, 2, 174, 174, 0.5, 0.06);
    this.turretSprite = this.turretNode.addComponent(Sprite);
    this.turretSprite.sizeMode = Sprite.SizeMode.CUSTOM;
    this.turretSprite.spriteFrame = this.assets.ui.turret_base ?? this.assets.turret.idle ?? null;
    this.turretNode.getComponent(UITransform)!.setContentSize(174, 174);

    // 金色能量炮管：锚点定在炮口轴心 (muzzleX, muzzleY)，旋转 -aim.angle 与上方瞄准虚线同轴对齐
    this.barrelNode = makeNode('TurretBarrel', this.turretLayer, TANK.muzzleX, TANK.muzzleY, 64, 108, 0.5, 0.30);
    this.barrelSprite = this.barrelNode.addComponent(Sprite);
    this.barrelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
    this.barrelSprite.spriteFrame = this.assets.ui.turret_barrel ?? null;
    this.barrelNode.getComponent(UITransform)!.setContentSize(64, 108);
    this.barrelNode.active = !!this.assets.ui.turret_barrel;

    this.muzzleG = addGraphics(this.turretLayer, 0, 0, TANK.width, TANK.height);

    this.loadedNode = makeNode('LoadedBall', this.turretLayer, TANK.muzzleX, TANK.muzzleY, 60, 60);
    this.loadedSprite = this.loadedNode.addComponent(Sprite);
    this.loadedSprite.sizeMode = Sprite.SizeMode.CUSTOM;
    this.loadedNode.active = false;

    this.shotLayer = makeNode('ShotLayer', this.tank, 0, 0, TANK.width, TANK.height, 0, 0);
    this.shotNode = makeNode('Shot', this.shotLayer, 0, 0, 10, 10);
    this.shotSprite = this.shotNode.addComponent(Sprite);
    this.shotSprite.sizeMode = Sprite.SizeMode.CUSTOM;
    this.shotNode.active = false;
  }

  setTankLayout(x: number, y: number, scale: number): void {
    this.baseTankX = x;
    this.baseTankY = y;
    this.tank.setPosition(x, y, 0);
    this.tank.setScale(scale, scale, 1);
  }

  setAim(v: AimView): void {
    this.aim = v;
  }

  setWorld(world: BallWorld): void {
    this.world = world;
    this.lastLineY = -1;
    this.lastDanger = -1;
    this.fireTimer = 0;
    this.swapTimer = 0;
    this.turretSq = 0;
    this.turretSqVel = 0;
    this.chargeBubbleTimer = 0;
    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.surfaceRipple = 0;
    this.particles.length = 0;
    this.rings.length = 0;
    this.shotTrail.length = 0;
    this.fxG.clear();
    this.fxDirty = false;
    for (const pt of this.popTexts) {
      pt.active = false;
      pt.node.active = false;
    }
  }

  /** 给附近球体施加软体果冻冲击波 */
  applyImpulse(x: number, y: number, strength: number, radius: number): void {
    const r2 = radius * radius;
    for (const v of this.views.values()) {
      const dx = v.lastX - x;
      const dy = v.lastY - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2 || d2 < 0.1) continue;
      const d = Math.sqrt(d2);
      const falloff = 1 - d / radius;
      const push = strength * falloff;
      v.ovx += (dx / d) * push;
      v.ovy += (dy / d) * push;
      v.sqAmp = Math.min(0.28, Math.max(v.sqAmp, 0.06 + falloff * 0.14));
      v.sqTime = 0;
      v.sqAngle = Math.atan2(dy, dx);
    }
  }

  shake(amp: number, duration = 0.2): void {
    this.shakeAmp = Math.max(this.shakeAmp, amp);
    this.shakeTime = Math.max(this.shakeTime, duration);
  }

  spawnText(x: number, y: number, text: string, colorHex = '#FFFFFF', fontSize = 26): void {
    const slot = this.popTexts.find((p) => !p.active) ?? this.popTexts[0];
    let px = Math.max(130, Math.min(TANK.width - 130, x));
    let py = Math.max(145, Math.min(TANK.height - 62, y));
    // 避开正在上升的相邻漂浮字，防止连击时文字重叠
    for (const other of this.popTexts) {
      if (!other.active || other === slot) continue;
      if (Math.abs(other.x - px) < 120 && Math.abs(other.y - py) < 34) {
        py = Math.min(TANK.height - 54, other.y + 36);
      }
    }
    slot.active = true;
    slot.x = px;
    slot.y = py;
    slot.vy = 64;
    slot.life = 0.85;
    slot.maxLife = 0.85;
    slot.baseScale = 1.18;
    slot.label.string = text;
    slot.label.fontSize = fontSize;
    slot.label.color = hex(colorHex);
    slot.node.active = true;
    slot.node.setPosition(slot.x, slot.y, 0);
    slot.node.setScale(1.3, 1.3, 1);
    slot.opacity.opacity = 255;
  }

  onCollide(aId: number, bId: number, nx: number, ny: number, speed: number): void {
    const k = Math.min(0.24, 0.05 + speed / 2600);
    const ang = Math.atan2(ny, nx);
    for (const id of [aId, bId]) {
      const v = this.views.get(id);
      if (!v) continue;
      v.sqAmp = Math.max(v.sqAmp, k);
      v.sqTime = 0;
      v.sqAngle = ang;
    }
  }

  onChargeMax(): void {
    this.turretSqVel += 2.6;
    this.rings.push({ x: TANK.muzzleX, y: TANK.muzzleY, r: 22, vr: 240, life: 0.34, maxLife: 0.34, color: hex('#FFE066', 245), width: 5 });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const sp = 90 + Math.random() * 110;
      this.particles.push({
        x: TANK.muzzleX + Math.cos(a) * 26,
        y: TANK.muzzleY + Math.sin(a) * 26,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.32,
        maxLife: 0.32,
        r: 2.5 + Math.random() * 2.5,
        color: hex('#FFE88A', 245),
        stretch: true,
      });
    }
    this.trimFx();
  }

  /** 发射后坐/水花（随蓄力强度放大） */
  onFire(power = 100): void {
    const p01 = Math.max(0.2, Math.min(1, (power - 35) / 65));
    this.fireTimer = 0.18 + p01 * 0.08;
    this.turretSqVel += 4.2 + p01 * 3.8;
    this.shotTrail.length = 0;
    this.spawnSqueeze(TANK.muzzleX, TANK.muzzleY);
    const rgb = BALL_COLOR_RGB[this.world.current ?? 4] ?? [160, 255, 240];
    const rad = (this.aim.angle * Math.PI) / 180;
    const fx = Math.sin(rad);
    const fy = Math.cos(rad);
    const count = Math.round(9 + p01 * 12);
    for (let i = 0; i < count; i++) {
      const spread = (Math.random() - 0.5) * 0.95;
      const a = Math.atan2(fy, fx) + spread;
      const sp = (95 + Math.random() * 180) * (0.75 + p01 * 0.5);
      this.particles.push({
        x: TANK.muzzleX + fx * 18,
        y: TANK.muzzleY + fy * 18,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.22 + Math.random() * 0.22,
        maxLife: 0.44,
        r: 2 + Math.random() * (3 + p01 * 2),
        color: p01 > 0.85 && i % 3 === 0 ? hex('#FFE066', 240) : new Color(rgb[0], rgb[1], rgb[2], 230),
        stretch: true,
      });
    }
    this.rings.push({
      x: TANK.muzzleX,
      y: TANK.muzzleY,
      r: 16,
      vr: 140 + p01 * 120,
      life: 0.26,
      maxLife: 0.26,
      color: p01 > 0.85 ? hex('#FFE066', 225) : hex('#B8FAFF', 200),
      width: 3 + p01 * 2,
    });
  }

  onSwap(): void {
    this.swapTimer = 0.22;
    this.turretSqVel -= 3.2;
    this.rings.push({ x: TANK.muzzleX, y: TANK.muzzleY, r: 14, vr: 140, life: 0.24, maxLife: 0.24, color: hex('#8FF0D8', 210), width: 3 });
  }

  onStick(x: number, y: number, power: number): void {
    this.shotTrail.length = 0;
    this.surfaceRipple = Math.min(1, this.surfaceRipple + 0.35 + power * 0.35);
    this.applyImpulse(x, y, 75 + power * 95, 160);
    this.rings.push({ x, y, r: 10, vr: 120, life: 0.3, maxLife: 0.3, color: hex('#B8FAFF', 160), width: 2.5 });
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 80;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 20,
        life: 0.28 + Math.random() * 0.2, maxLife: 0.48, r: 2 + Math.random() * 2.5,
        color: hex('#CFFBFF', 200),
      });
    }
    this.trimFx();
  }

  spawnBounce(x: number, y: number, wall: WallSide): void {
    const dir = wall === 'left' ? 1 : -1;
    for (let i = 0; i < 8; i++) {
      const a = (wall === 'left' ? 0 : Math.PI) + (Math.random() - 0.5) * 1.4;
      const sp = 60 + Math.random() * 140;
      this.particles.push({
        x: x + dir * 4,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + 20,
        life: 0.24 + Math.random() * 0.16,
        maxLife: 0.4,
        r: 1.8 + Math.random() * 3,
        color: hex('#B8FAFF', 220),
        stretch: true,
      });
    }
    this.rings.push({ x, y, r: 8, vr: 120, life: 0.26, maxLife: 0.26, color: hex('#CFFBFF', 190), width: 2.5 });
    this.trimFx();
  }

  spawnMerge(x: number, y: number, value: number, combo: number, score: number, squeezed: boolean): void {
    const rgb = BALL_COLOR_RGB[value] ?? [160, 255, 240];
    const base = new Color(rgb[0], rgb[1], rgb[2], 255);
    const big = value >= 64 || combo >= 2;
    const count = big ? 24 : 14;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (big ? 90 : 65) + Math.random() * (big ? 190 : 145);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + 35,
        life: 0.42 + Math.random() * 0.42,
        maxLife: 0.84,
        r: 2.2 + Math.random() * (big ? 6 : 4.5),
        color: i % 4 === 0 ? hex('#FFFFFF', 240) : base,
        stretch: true,
      });
    }
    this.rings.push({ x, y, r: 10, vr: big ? 220 : 165, life: 0.48, maxLife: 0.48, color: base, width: big ? 5 : 4 });
    this.rings.push({ x, y, r: 5, vr: 110, life: 0.34, maxLife: 0.34, color: hex('#FFFFFF', 240), width: 2.5 });
    this.applyImpulse(x, y, big ? 175 : 110, big ? 220 : 170);
    this.surfaceRipple = Math.min(1, this.surfaceRipple + 0.45);
    if (big) this.shake(combo >= 3 || value >= 256 ? 7 : 4, 0.2);

    const colHex = BALL_COLORS[value] ?? '#FFFFFF';
    const tag = combo > 1 ? `×${combo}  +${score}` : `+${score}`;
    this.spawnText(x, y + 18, tag, combo > 1 ? '#FFE08A' : colHex, combo > 1 ? 30 : 25);
    if (squeezed && combo <= 1) {
      this.spawnText(x, y + 48, '挤入 +25%!', '#8FF0D8', 22);
    }
    this.trimFx();
  }

  spawnSqueeze(x: number, y: number): void {
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 55 + Math.random() * 110;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.32,
        maxLife: 0.32,
        r: 1.8 + Math.random() * 3.4,
        color: hex('#BFFCFF', 235),
        stretch: true,
      });
    }
    this.rings.push({ x, y, r: 8, vr: 150, life: 0.32, maxLife: 0.32, color: hex('#8FF0D8', 220), width: 3 });
    this.applyImpulse(x, y, 120, 140);
    this.trimFx();
  }

  spawnGold(x: number, y: number): void {
    for (let i = 0; i < 48; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 90 + Math.random() * 260;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + 60,
        life: 0.9 + Math.random() * 0.7,
        maxLife: 1.6,
        r: 2.5 + Math.random() * 6,
        color: Math.random() > 0.35 ? hex('#FFD24A') : hex('#FFF6D0'),
        stretch: true,
      });
    }
    this.rings.push({ x, y, r: 10, vr: 520, life: 0.9, maxLife: 0.9, color: hex('#FFD24A'), width: 8 });
    this.shake(10, 0.35);
    this.trimFx();
  }

  spawnDrop(x: number, y: number): void {
    this.rings.push({ x, y, r: 6, vr: 110, life: 0.45, maxLife: 0.45, color: hex('#8FE6F7', 210), width: 3 });
    this.trimFx();
  }

  spawnWildLoaded(): void {
    const palette = ['#FF6B9D', '#FFA84A', '#FFE066', '#6EFFC8', '#66E8FF', '#C788FF'];
    for (let i = 0; i < 18; i++) {
      const col = hex(palette[i % palette.length], 245);
      this.particles.push({
        x: TANK.muzzleX + (Math.random() - 0.5) * 80,
        y: TANK.muzzleY + 20 + Math.random() * 60,
        vx: (Math.random() - 0.5) * 140,
        vy: 340 + Math.random() * 420,
        life: 0.75 + Math.random() * 0.4,
        maxLife: 1.15,
        r: 3 + Math.random() * 3.5,
        color: col,
        stretch: true,
      });
    }
    this.rings.push({ x: TANK.muzzleX, y: TANK.muzzleY, r: 24, vr: 320, life: 0.5, maxLife: 0.5, color: hex('#FF9FF3', 240), width: 6 });
    this.trimFx();
  }

  spawnIceBreak(x: number, y: number): void {
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 90 + Math.random() * 190;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + 40,
        life: 0.45 + Math.random() * 0.25,
        maxLife: 0.7,
        r: 2.5 + Math.random() * 3.5,
        color: i % 2 === 0 ? hex('#C8FBFF', 245) : hex('#FFFFFF', 245),
        stretch: true,
      });
    }
    this.rings.push({ x, y, r: 14, vr: 210, life: 0.35, maxLife: 0.35, color: hex('#9BF6FF', 235), width: 4 });
    this.spawnText(x, y + 36, '破冰! +30', '#B8FAFF', 26);
    this.trimFx();
  }

  onTide(wave: number): void {
    this.surfaceRipple = 1;
    this.shake(4.5, 0.18);
    this.spawnText(TANK.width / 2, TANK.topY - 88, `🌊 第 ${wave} 波潮汐涌入!`, '#7CF7FF', 26);
  }

  private trimFx(): void {
    if (this.particles.length > 220) this.particles.splice(0, this.particles.length - 220);
    if (this.rings.length > 40) this.rings.splice(0, this.rings.length - 40);
  }

  sync(dt: number): void {
    this.frame++;
    const now = this.world.worldTime;
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.swapTimer = Math.max(0, this.swapTimer - dt);
    this.surfaceRipple = Math.max(0, this.surfaceRipple - dt * 1.4);

    // ---- 震屏衰减
    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - dt);
      const decay = this.shakeAmp * (this.shakeTime / 0.2);
      const sx = (Math.random() - 0.5) * 2 * decay;
      const sy = (Math.random() - 0.5) * 2 * decay;
      this.tank.setPosition(this.baseTankX + sx, this.baseTankY + sy, 0);
      if (this.shakeTime <= 0) {
        this.shakeAmp = 0;
        this.tank.setPosition(this.baseTankX, this.baseTankY, 0);
      }
    }

    const totalBalls = this.world.balls.length;
    const breatheEnabled = totalBalls <= 140;

    // ---- 球节点（对象池 + 真实物理移动 + 软体果冻形变）
    for (const b of this.world.balls) {
      let v = this.views.get(b.id);
      if (!v) {
        const art = this.assets.ball(b.value);
        if (!art) continue;
        v = this.pool.pop() ?? this.createView();
        v.id = b.id;
        v.value = b.value;
        v.r = b.r;
        v.displayScale = art.displayScale;
        v.wobblePhase = b.wobblePhase;
        v.seen = this.frame;
        v.lastX = b.x;
        v.lastY = b.y;
        v.lastOpacity = 255;
        v.ox = 0;
        v.oy = 0;
        v.ovx = 0;
        v.ovy = 0;
        v.sqAmp = 0;
        v.sqTime = 0;
        v.sqAngle = 0;
        v.node.active = true;
        v.node.angle = 0;
        v.node.setScale(1, 1, 1);
        v.opacity.opacity = 255;
        const wildArt = b.wild ? this.assets.ui.wild_orb : undefined;
        v.sprite.spriteFrame = wildArt ?? art.frame;
        v.sprite.color = Color.WHITE;
        const drawSz = wildArt ? b.r * 2.5 : b.r * 2 * art.displayScale;
        v.node.getComponent(UITransform)!.setContentSize(drawSz, drawSz);
        v.node.setPosition(b.x, b.y, 0);
        this.views.set(b.id, v);
        this.stackLayer.addChild(v.node);
      }
      v.seen = this.frame;
      if (v.value !== b.value || (b.wild && this.assets.ui.wild_orb && v.sprite.spriteFrame !== this.assets.ui.wild_orb)) {
        v.value = b.value;
        v.r = b.r;
        const art = this.assets.ball(b.value);
        const wildArt = b.wild ? this.assets.ui.wild_orb : undefined;
        if (wildArt) {
          v.sprite.spriteFrame = wildArt;
          v.node.getComponent(UITransform)!.setContentSize(b.r * 2.5, b.r * 2.5);
        } else if (art) {
          v.displayScale = art.displayScale;
          v.sprite.spriteFrame = art.frame;
          v.node.getComponent(UITransform)!.setContentSize(b.r * 2 * art.displayScale, b.r * 2 * art.displayScale);
        }
      }

      if (Math.abs(v.ox) > 0.05 || Math.abs(v.oy) > 0.05 || Math.abs(v.ovx) > 0.5 || Math.abs(v.ovy) > 0.5) {
        const k = 190;
        const c = 14;
        v.ovx += (-k * v.ox - c * v.ovx) * dt;
        v.ovy += (-k * v.oy - c * v.ovy) * dt;
        v.ox += v.ovx * dt;
        v.oy += v.ovy * dt;
      } else {
        v.ox = 0;
        v.oy = 0;
        v.ovx = 0;
        v.ovy = 0;
      }

      const age = now - b.bornAt;
      const sp = Math.hypot(b.vx, b.vy);
      const idleBob = breatheEnabled && b.state === 'stack' && sp < 60 ? Math.sin(now * 2.1 + v.wobblePhase) * 1.1 : 0;
      const drawX = b.x + v.ox;
      const drawY = b.y + v.oy + idleBob;
      if (Math.abs(v.lastX - drawX) > 0.02 || Math.abs(v.lastY - drawY) > 0.02) {
        v.node.setPosition(drawX, drawY, 0);
        v.lastX = drawX;
        v.lastY = drawY;
      }

      // 高速飞行拖尾气泡
      if (b.state === 'stack' && sp > 600 && Math.random() < 0.35) {
        const rgb = BALL_COLOR_RGB[b.value] ?? [160, 255, 240];
        this.particles.push({
          x: b.x + (Math.random() - 0.5) * b.r * 0.6,
          y: b.y + (Math.random() - 0.5) * b.r * 0.6,
          vx: -b.vx * 0.05 + (Math.random() - 0.5) * 30,
          vy: -b.vy * 0.05 + 20,
          life: 0.24,
          maxLife: 0.24,
          r: 2 + Math.random() * 2.5,
          color: new Color(rgb[0], rgb[1], rgb[2], 175),
        });
        this.trimFx();
      }

      // 软体挤压/呼吸/速度拉伸
      let sx = 1;
      let sy = 1;
      let rot = 0;
      if (age >= 0 && age < 0.32) {
        const t = age / 0.32;
        const pop = 1 + 0.32 * (1 - t) * (1 - t) * Math.cos(t * Math.PI * 1.5);
        sx *= pop;
        sy *= pop;
      }
      if (v.sqAmp > 0.003) {
        v.sqTime += dt;
        v.sqAmp *= Math.exp(-6.5 * dt);
        const osc = Math.sin(v.sqTime * 22) * v.sqAmp;
        sx *= 1 + osc;
        sy *= 1 - osc * 0.85;
        rot = Math.sin(v.sqAngle) * osc * 16;
      } else {
        v.sqAmp = 0;
      }
      if (breatheEnabled && b.state === 'stack' && sp < 80) {
        const br = Math.sin(now * 2.4 + v.wobblePhase) * 0.024;
        sx *= 1 + br;
        sy *= 1 - br;
      }

      if (b.state === 'falling') {
        v.node.angle += dt * 48;
        if (b.removeReason) {
          const t = Math.min(1, b.age / 0.55);
          const op = Math.round(255 * (1 - t));
          if (op !== v.lastOpacity) {
            v.opacity.opacity = op;
            v.lastOpacity = op;
          }
          sx *= 1 - 0.35 * t;
          sy *= 1 - 0.35 * t;
        } else if (v.lastOpacity !== 255) {
          v.opacity.opacity = 255;
          v.lastOpacity = 255;
        }
      } else {
        v.node.angle = b.wild ? (now * 140) % 360 : rot;
        if (v.lastOpacity !== 255) {
          v.opacity.opacity = 255;
          v.lastOpacity = 255;
        }
      }
      v.node.setScale(sx, sy, 1);
    }

    for (const [id, v] of this.views) {
      if (v.seen !== this.frame) {
        v.node.active = false;
        v.lastX = Number.NaN;
        v.lastY = Number.NaN;
        this.views.delete(id);
        this.pool.push(v);
      }
    }

    // ---- 炮台弹簧果冻回弹 / 蓄力吸入 / 旋转轨道能量球 / 伸缩导流管
    const aimingNow = this.aim.aiming && this.world.current !== null && !this.aim.cancelled;
    const chargingNow = !!this.aim.charging && aimingNow;
    const charge01 = chargingNow ? Math.max(0, Math.min(1, (this.aim.power - 42) / 58)) : 0;
    const fullCharge = chargingNow && charge01 >= 0.98;
    const state: 'idle' | 'charge' | 'fire' =
      this.fireTimer > 0.04 ? 'fire' : chargingNow ? 'charge' : 'idle';
    if (state !== this.turretState) {
      this.turretState = state;
      if (!this.assets.ui.turret_base) {
        this.turretSprite.spriteFrame = (this.assets.turret[state] ?? this.assets.turret.idle) ?? null;
      }
    }
    if (!this.assets.ui.turret_base && Math.abs(this.aim.angle) > 8) {
      this.turretFacing = this.aim.angle < 0 ? -1 : 1;
    } else {
      this.turretFacing = 1;
    }

    // 弹簧阻尼果冻振动
    this.turretSqVel += (-210 * this.turretSq - 11 * this.turretSqVel) * dt;
    this.turretSq += this.turretSqVel * dt;

    // 蓄力吸入水泡粒子
    if (chargingNow) {
      this.chargeBubbleTimer -= dt;
      if (this.chargeBubbleTimer <= 0) {
        this.chargeBubbleTimer = fullCharge ? 0.032 : 0.055;
        const a = Math.random() * Math.PI * 2;
        const dist = 54 + Math.random() * 28;
        this.particles.push({
          x: TANK.muzzleX + Math.cos(a) * dist,
          y: TANK.muzzleY + Math.sin(a) * dist,
          vx: -Math.cos(a) * (135 + charge01 * 90),
          vy: -Math.sin(a) * (135 + charge01 * 90),
          life: 0.24,
          maxLife: 0.24,
          r: 2 + Math.random() * 2.2,
          color: fullCharge ? hex('#FFE88A', 225) : hex('#9AF8FF', 205),
        });
        this.trimFx();
      }
    } else {
      this.chargeBubbleTimer = 0;
    }

    if (this.turretNode) {
      const fireRecoil = this.fireTimer > 0 ? Math.sin((this.fireTimer / 0.24) * Math.PI) * 0.22 : 0;
      const chargeSquash = chargingNow ? 0.04 + charge01 * 0.2 : 0;
      const swapPop = this.swapTimer > 0 ? Math.sin((this.swapTimer / 0.22) * Math.PI) * 0.14 : 0;
      const breathe = Math.sin(now * 2.4) * 0.025;
      const springX = this.turretSq * 0.65;
      const springY = -this.turretSq * 0.55;
      const sx = (1 + fireRecoil + chargeSquash - swapPop + springX + breathe) * this.turretFacing;
      const sy = 1 - fireRecoil * 0.6 - chargeSquash * 0.72 + swapPop + springY - breathe * 0.8;
      this.turretNode.setScale(sx, sy, 1);
      const jitterX = fullCharge ? Math.sin(now * 65) * 2.0 : 0;
      const idleBobY = chargingNow ? -charge01 * 4 : Math.sin(now * 2.4 + 1.1) * 1.8;
      this.turretNode.setPosition(TANK.turretX + jitterX, 2 + idleBobY, 0);
      this.turretNode.angle = aimingNow ? -this.aim.angle * 0.08 : Math.sin(now * 1.4) * 1.6;
    }

    // 旋转金色炮管：严格指向瞄准角度 -this.aim.angle，并在蓄力/发射时沿轴向伸缩后坐
    if (this.barrelNode && this.barrelNode.active) {
      const radB = (this.aim.angle * Math.PI) / 180;
      const fireFwd = this.fireTimer > 0 ? Math.sin((this.fireTimer / 0.24) * Math.PI) * 12 : 0;
      const barrelRecoil = -charge01 * 10 + fireFwd;
      const bScaleX = 1 + charge01 * 0.12 + this.turretSq * 0.35;
      const bScaleY = 1 - charge01 * 0.16 + (fireFwd > 0 ? 0.12 : 0) - this.turretSq * 0.25;
      this.barrelNode.angle = -this.aim.angle;
      this.barrelNode.setPosition(
        TANK.muzzleX + Math.sin(radB) * barrelRecoil,
        TANK.muzzleY + Math.cos(radB) * barrelRecoil,
        0,
      );
      this.barrelNode.setScale(bScaleX, bScaleY, 1);
    }

    // ---- 发光水圈底座 + 旋转能量水珠 + 伸缩导流喷嘴 + 蓄力取消区
    this.muzzleG.clear();
    const glow = 0.5 + 0.5 * Math.sin(now * 4.5);
    const ringCol = fullCharge
      ? hex('#FFE066', 250)
      : chargingNow
      ? hex('#7CF7FF', Math.round(170 + glow * 70))
      : hex('#8FF6FF', Math.round(95 + glow * 65));
    this.muzzleG.fillColor = hex(fullCharge ? '#FFD24A' : '#4BE8FF', Math.round((fullCharge ? 48 : 28) + glow * 22));
    this.muzzleG.ellipse(TANK.turretX, 22, 132 + charge01 * 18, 22);
    this.muzzleG.fill();
    this.muzzleG.strokeColor = hex(fullCharge ? '#FFE88A' : '#9AF8FF', Math.round(95 + glow * 60));
    this.muzzleG.lineWidth = 2;
    this.muzzleG.ellipse(TANK.turretX, 22, 126 + charge01 * 16, 19);
    this.muzzleG.stroke();

    // 下拉取消蓄力区域提示环
    if (chargingNow || this.aim.cancelled) {
      const canc = !!this.aim.cancelled;
      const pulseC = 0.5 + 0.5 * Math.sin(now * (canc ? 14 : 6));
      this.muzzleG.fillColor = canc ? hex('#FF4D66', Math.round(55 + pulseC * 45)) : hex('#FF7B8E', 24);
      this.muzzleG.ellipse(TANK.turretX, 46, 98 + (canc ? pulseC * 10 : 0), 34);
      this.muzzleG.fill();
      this.muzzleG.strokeColor = canc ? hex('#FF8FA0', 245) : hex('#FF8FA0', 110);
      this.muzzleG.lineWidth = canc ? 3.2 : 1.8;
      this.muzzleG.ellipse(TANK.turretX, 46, 98 + (canc ? pulseC * 10 : 0), 34);
      this.muzzleG.stroke();
    }

    // 旋转指向水炮准星环
    const rad = (this.aim.angle * Math.PI) / 180;
    const ux = Math.sin(rad);
    const uy = Math.cos(rad);
    const px = -uy;
    const py = ux;
    this.muzzleG.strokeColor = ringCol;
    this.muzzleG.lineWidth = chargingNow ? 2.5 : 2.2;
    this.muzzleG.circle(TANK.muzzleX, TANK.muzzleY, 27 + glow * 2);
    this.muzzleG.stroke();

    // 4 颗绕炮口公转的液态能量水珠
    const orbitR = 44 - charge01 * 12;
    const orbitAngle = now * (2.8 + charge01 * 8.0);
    for (let i = 0; i < 4; i++) {
      const a = orbitAngle + (i * Math.PI) / 2;
      const ox = TANK.muzzleX + Math.cos(a) * orbitR;
      const oy = TANK.muzzleY + Math.sin(a) * orbitR;
      this.muzzleG.fillColor = fullCharge ? hex('#FFE066', 235) : hex('#A2FBFF', Math.round(145 + charge01 * 90));
      this.muzzleG.circle(ox, oy, 3.2 + charge01 * 2.2);
      this.muzzleG.fill();
    }

    // 炮口外圈蓄力进度弧（顺时针 0 → 100%，青色过渡至黄金）
    if (chargingNow) {
      const arcR = 36 + (fullCharge ? Math.sin(now * 24) * 1.5 : 0);
      this.muzzleG.strokeColor = hex('#05354B', 130);
      this.muzzleG.lineWidth = 6;
      this.muzzleG.circle(TANK.muzzleX, TANK.muzzleY, arcR);
      this.muzzleG.stroke();

      const startA = Math.PI * 0.5;
      const endA = startA - Math.max(0.08, charge01) * Math.PI * 2;
      this.muzzleG.strokeColor = fullCharge ? hex('#FFE066', 255) : hex('#6EFFC8', 240);
      this.muzzleG.lineWidth = 6;
      this.muzzleG.arc(TANK.muzzleX, TANK.muzzleY, arcR, startA, endA, false);
      this.muzzleG.stroke();
    }

    // 沿瞄准方向的双层伸缩导流推进翼 + 前端准星尖角
    const recoilShift = this.fireTimer > 0 ? Math.sin((this.fireTimer / 0.24) * Math.PI) * 10 : -charge01 * 10;
    const barrelLen = 36 + recoilShift;
    for (const step of [0, 1]) {
      const d = barrelLen + step * 11;
      const span = 12 - step * 3;
      this.muzzleG.strokeColor = fullCharge ? hex('#FFE88A', 225) : hex('#B8FAFF', 165 + step * 45);
      this.muzzleG.lineWidth = 2.6;
      this.muzzleG.moveTo(TANK.muzzleX + ux * (d - 6) + px * span, TANK.muzzleY + uy * (d - 6) + py * span);
      this.muzzleG.lineTo(TANK.muzzleX + ux * (d + 4), TANK.muzzleY + uy * (d + 4));
      this.muzzleG.lineTo(TANK.muzzleX + ux * (d - 6) - px * span, TANK.muzzleY + uy * (d - 6) - py * span);
      this.muzzleG.stroke();
    }

    const tipDist = 48 + glow * 3 + recoilShift * 0.6;
    this.muzzleG.fillColor = ringCol;
    this.muzzleG.moveTo(TANK.muzzleX + ux * (tipDist + 11), TANK.muzzleY + uy * (tipDist + 11));
    this.muzzleG.lineTo(TANK.muzzleX + ux * tipDist + px * 8.5, TANK.muzzleY + uy * tipDist + py * 8.5);
    this.muzzleG.lineTo(TANK.muzzleX + ux * tipDist - px * 8.5, TANK.muzzleY + uy * tipDist - py * 8.5);
    this.muzzleG.close();
    this.muzzleG.fill();

    // 万能彩球七彩光环 + 道具选球态脉冲光圈
    if (this.world.currentWild && this.world.current !== null) {
      const hueShift = (now * 3) % (Math.PI * 2);
      const rCol = Math.sin(hueShift) > 0 ? hex('#FF7CE5', 235) : hex('#7CFFFA', 235);
      this.muzzleG.strokeColor = rCol;
      this.muzzleG.lineWidth = 3.5;
      this.muzzleG.circle(TANK.muzzleX, TANK.muzzleY, 31 + Math.sin(now * 8) * 3);
      this.muzzleG.stroke();
    }
    for (const b of this.world.balls) {
      if (b.state !== 'stack') continue;
      if (b.iced) {
        const iPulse = 0.5 + 0.5 * Math.sin(now * 4 + b.id);
        this.muzzleG.fillColor = hex('#BDF7FF', Math.round(62 + iPulse * 25));
        this.muzzleG.circle(b.x, b.y, b.r + 3);
        this.muzzleG.fill();
        this.muzzleG.strokeColor = hex('#E0FFFF', Math.round(195 + iPulse * 55));
        this.muzzleG.lineWidth = 3;
        const ir = b.r + 4;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + now * 0.35;
          const x0 = b.x + Math.cos(a) * ir;
          const y0 = b.y + Math.sin(a) * ir;
          if (k === 0) this.muzzleG.moveTo(x0, y0);
          else this.muzzleG.lineTo(x0, y0);
        }
        this.muzzleG.close();
        this.muzzleG.stroke();
      }
      if (b.pierceUntil && now < b.pierceUntil) {
        const sp = Math.hypot(b.vx, b.vy) || 1;
        const dx = b.vx / sp;
        const dy = b.vy / sp;
        this.muzzleG.strokeColor = hex('#FFE87C', 240);
        this.muzzleG.lineWidth = 3.6;
        this.muzzleG.circle(b.x, b.y, b.r + 6);
        this.muzzleG.stroke();
        this.muzzleG.strokeColor = hex('#8FFFD4', 220);
        this.muzzleG.lineWidth = 2.6;
        const tipX = b.x + dx * (b.r + 14);
        const tipY = b.y + dy * (b.r + 14);
        this.muzzleG.moveTo(b.x - dy * (b.r + 4), b.y + dx * (b.r + 4));
        this.muzzleG.lineTo(tipX, tipY);
        this.muzzleG.lineTo(b.x + dy * (b.r + 4), b.y - dx * (b.r + 4));
        this.muzzleG.stroke();
      }
      if (b.wild) {
        const wPulse = 0.5 + 0.5 * Math.sin(now * 10 + b.id);
        this.muzzleG.strokeColor = wPulse > 0.5 ? hex('#FF8CF0', 235) : hex('#7CFFFA', 235);
        this.muzzleG.lineWidth = 3.2;
        this.muzzleG.circle(b.x, b.y, b.r + 5 + wPulse * 3);
        this.muzzleG.stroke();
      } else if (this.aim.selecting) {
        const sPulse = 0.5 + 0.5 * Math.sin(now * 8 + b.id * 0.5);
        this.muzzleG.strokeColor =
          this.aim.selecting === 'melt'
            ? hex('#FF8A98', Math.round(135 + sPulse * 100))
            : hex('#8FF0D8', Math.round(135 + sPulse * 100));
        this.muzzleG.lineWidth = 2.4;
        this.muzzleG.circle(b.x, b.y, b.r + 3 + sPulse * 3);
        this.muzzleG.stroke();
      }
    }

    if (this.fireTimer > 0) {
      this.muzzleG.fillColor = hex('#FFFFFF', Math.round(190 * (this.fireTimer / 0.24)));
      this.muzzleG.circle(TANK.muzzleX, TANK.muzzleY, 18 + (1 - this.fireTimer / 0.24) * 34);
      this.muzzleG.fill();
    }

    // ---- 装填球（放大显示 + 底部深海反差衬托圈；万能彩球切换专属炫彩星耀球皮）
    const loaded = this.world.current;
    if (loaded !== null) {
      const art = this.assets.ball(loaded);
      const isWildLoaded = this.world.currentWild;
      const wildFrame = isWildLoaded ? this.assets.ui.wild_orb : undefined;
      if (wildFrame || art) {
        this.loadedNode.active = true;
        this.loadedSprite.spriteFrame = wildFrame ?? art!.frame;
        const r = isWildLoaded ? 24 : RADIUS[loaded];
        const size = wildFrame ? 74 : Math.max(66, r * 2 * art!.displayScale * 1.16);
        this.loadedNode.getComponent(UITransform)!.setContentSize(size, size);
        const swapScale = this.swapTimer > 0 ? 1 + Math.sin((this.swapTimer / 0.22) * Math.PI) * 0.26 : 1;
        const compX = 1 + charge01 * 0.14;
        const compY = 1 - charge01 * 0.14;
        const jx = fullCharge ? Math.sin(now * 72) * 1.4 : 0;
        const barrelTipOffset = 46 - charge01 * 10 + (this.fireTimer > 0 ? 10 : 0);
        const lx = TANK.muzzleX + ux * barrelTipOffset + jx;
        const ly = TANK.muzzleY + uy * barrelTipOffset + Math.sin(now * 3.5) * 1.6;
        this.muzzleG.fillColor = hex('#032234', 160);
        this.muzzleG.circle(lx, ly, size * 0.43);
        this.muzzleG.fill();
        this.muzzleG.strokeColor = isWildLoaded ? hex('#FF9FF3', 235) : hex('#B8FAFF', 175);
        this.muzzleG.lineWidth = isWildLoaded ? 3 : 2;
        this.muzzleG.circle(lx, ly, size * 0.44);
        this.muzzleG.stroke();
        this.loadedNode.setPosition(lx, ly, 0);
        this.loadedNode.angle = isWildLoaded ? (now * 58) % 360 : 0;
        this.loadedNode.setScale(
          swapScale * compX * (1 + 0.04 * Math.sin(now * 6)),
          swapScale * compY * (1 - 0.04 * Math.sin(now * 6)),
          1,
        );
      }
    } else {
      this.loadedNode.active = false;
    }
    this.shotNode.active = false;

    this.drawAmbient(dt, now);
    this.drawLine();
    this.drawFx(dt);
    this.drawPopTexts(dt);
    this.drawAim(now);
  }

  private createView(): BallView {
    const node = makeNode('ball', this.stackLayer, 0, 0, 40, 40);
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.type = Sprite.Type.SIMPLE;
    const opacity = node.addComponent(UIOpacity);
    return {
      id: 0,
      value: 0,
      r: 18,
      displayScale: 1,
      wobblePhase: 0,
      node,
      sprite,
      opacity,
      seen: 0,
      lastX: Number.NaN,
      lastY: Number.NaN,
      lastOpacity: 255,
      ox: 0,
      oy: 0,
      ovx: 0,
      ovy: 0,
      sqAmp: 0,
      sqTime: 0,
      sqAngle: 0,
    };
  }

  private drawAmbient(dt: number, now: number): void {
    const g = this.ambientG;
    g.clear();
    const fever = this.world.isFever();
    const danger = this.world.getDangerLevel();
    const speedMult = fever ? 1.5 : 1;

    // 手持万能彩球时：水箱左右边栏亮起外周余光七彩灯带（视线看顶部时余光立刻感知）
    if (this.world.currentWild && this.world.current !== null) {
      const pColors = ['#FF6B9D', '#FFE066', '#6EFFC8', '#66E8FF', '#C788FF'];
      const ci = Math.floor(now * 4) % pColors.length;
      const pulseW = 0.55 + 0.45 * Math.sin(now * 7);
      const edgeCol = hex(pColors[ci], Math.round(95 + pulseW * 95));
      g.fillColor = hex(pColors[(ci + 1) % pColors.length], Math.round(42 + pulseW * 45));
      g.roundRect(4, 96, 12, TANK.topY - 110, 6);
      g.fill();
      g.roundRect(TANK.width - 16, 96, 12, TANK.topY - 110, 6);
      g.fill();
      g.strokeColor = edgeCol;
      g.lineWidth = 3.5;
      g.roundRect(4, 4, TANK.width - 8, TANK.height - 8, 32);
      g.stroke();
    }

    // 顶部水波弯月面微荡（潮汐预警时闪烁珊瑚金向下波纹）
    const tide = this.world.getTideState();
    const tidePulse = tide.warning ? 0.5 + 0.5 * Math.sin(now * 8) : 0;
    g.strokeColor = tide.warning
      ? hex('#FF8A65', Math.round(160 + 85 * tidePulse))
      : fever
        ? hex('#FFE08A', 120)
        : hex('#B8FAFF', 85);
    g.lineWidth = tide.warning ? 4.5 : 3;
    const amp = 2.5 + this.surfaceRipple * 6 + (tide.warning ? 4 : 0);
    const topY = TANK.topY - 4;
    g.moveTo(18, topY);
    for (let x = 36; x <= TANK.width - 18; x += 36) {
      const dy = Math.sin(x * 0.025 + now * 4.2) * amp;
      g.lineTo(x, topY + dy);
    }
    g.stroke();

    if (tide.warning) {
      g.strokeColor = hex('#FF9B70', Math.round(140 + 95 * tidePulse));
      g.lineWidth = 3;
      const cy = topY - 14 - Math.sin(now * 8) * 3;
      for (const cx of [170, 340, 510]) {
        g.moveTo(cx - 12, cy + 7);
        g.lineTo(cx, cy - 3);
        g.lineTo(cx + 12, cy + 7);
      }
      g.stroke();
    }

    // 上升的微气泡
    for (const b of this.bubbles) {
      b.y += b.vy * speedMult * dt;
      if (b.y > TANK.height + 10) {
        b.y = -10;
        b.x = 24 + Math.random() * (TANK.width - 48);
      }
      const sway = Math.sin(now * 2.2 + b.phase) * 6;
      const bx = b.x + sway;
      const col = danger > 0.3 && b.y < 320 ? hex('#FF8A98', Math.round(b.alpha * 1.2)) : fever ? hex('#FFE8A6', Math.round(b.alpha)) : hex('#C8FAFF', Math.round(b.alpha));
      g.fillColor = col;
      g.circle(bx, b.y, b.r);
      g.fill();
      g.fillColor = hex('#FFFFFF', Math.round(b.alpha * 0.85));
      g.circle(bx - b.r * 0.28, b.y + b.r * 0.28, b.r * 0.28);
      g.fill();
    }

    // 水底暗流 / 气泡涡流视觉（聚拢期柔和螺旋水圈）
    const vortex = this.world.getVortexState();
    if (vortex.active) {
      const fade = Math.min(1, vortex.remain / 1.0);
      for (let k = 0; k < 3; k++) {
        const vr = 56 + k * 54 + ((now * 90 + k * 40) % 46);
        const startA = now * (2.6 - k * 0.5) + k * 2.1;
        g.strokeColor = hex('#7CF7FF', Math.round((130 - k * 30) * fade));
        g.lineWidth = 3.2 - k * 0.6;
        g.arc(vortex.cx, vortex.cy, vr, startA, startA + Math.PI * 1.15, true);
        g.stroke();
      }
      g.fillColor = hex('#A6FCFF', Math.round(32 * fade));
      g.circle(vortex.cx, vortex.cy, 62);
      g.fill();
    }

    // 飞球水滴彗星尾迹
    if (this.shotTrail.length >= 2 && this.world.shot) {
      const rgb = BALL_COLOR_RGB[this.world.shot.value] ?? [160, 255, 240];
      const baseR = this.world.shot.r * 0.65;
      const len = this.shotTrail.length;
      for (let i = 0; i < len - 1; i++) {
        const pt = this.shotTrail[i];
        const t = (i + 1) / len;
        g.fillColor = new Color(rgb[0], rgb[1], rgb[2], Math.round(110 * t * t));
        g.circle(pt.x, pt.y, baseR * t);
        g.fill();
      }
    }
  }

  private drawLine(): void {
    const y = this.world.lineY;
    const danger = this.world.getDangerLevel();
    if (Math.abs(y - this.lastLineY) < 0.5 && Math.abs(danger - this.lastDanger) < 0.02) return;
    this.lastLineY = y;
    this.lastDanger = danger;
    const g = this.lineG;
    g.clear();
    g.fillColor = hex('#FF2338', 14 + Math.round(danger * 36));
    g.rect(0, 0, TANK.width, y);
    g.fill();
    const pulse = 0.55 + 0.45 * Math.sin(this.world.worldTime * Math.PI * 2 * 1.2);
    const alpha = Math.round(115 + danger * 120 + pulse * 20);
    g.strokeColor = hex('#FF4D5E', Math.min(255, alpha));
    g.lineWidth = 3 + danger * 2;
    for (let x = 10; x < TANK.width - 10; x += 28) {
      g.moveTo(x, y);
      g.lineTo(Math.min(TANK.width - 10, x + 16), y);
    }
    g.stroke();
    g.fillColor = hex('#FF4D5E', Math.min(240, alpha));
    g.moveTo(6, y + 10);
    g.lineTo(22, y + 10);
    g.lineTo(14, y - 2);
    g.close();
    g.fill();
    g.moveTo(TANK.width - 6, y + 10);
    g.lineTo(TANK.width - 22, y + 10);
    g.lineTo(TANK.width - 14, y - 2);
    g.close();
    g.fill();
    this.lineLabel.node.setPosition(28, y + 14, 0);
    this.lineLabel.node.active = y > 30;
  }

  private drawAim(now: number): void {
    const g = this.aimG;
    const show =
      this.aim.aiming &&
      this.aim.showLine !== false &&
      this.world.current !== null &&
      !this.aim.cancelled &&
      !this.aim.selecting;
    if (!show) {
      if (this.aimWasVisible) {
        g.clear();
        this.aimTipNode.active = false;
        this.aimBadge.node.active = false;
        this.aimWasVisible = false;
      }
      return;
    }
    this.aimWasVisible = true;
    g.clear();
    const pred = this.world.predictAim(this.aim.angle, this.aim.power, TANK.aimLineLen, 1);
    const pts = pred.pts;
    if (pts.length < 2) {
      this.aimTipNode.active = false;
      this.aimBadge.node.active = false;
      return;
    }

    const isWild = this.world.currentWild;
    const isMerge = pred.hitKind === 'merge';
    const charge01 = this.aim.charging ? Math.max(0, Math.min(1, (this.aim.power - 42) / 58)) : 0.4;
    const rainbowPalette = ['#FF6B9D', '#FFA84A', '#FFE066', '#6EFFC8', '#66E8FF', '#C788FF'];
    const beadColor = isMerge
      ? hex('#FFE066', 240)
      : charge01 >= 0.95
      ? hex('#8FFFD4', 225)
      : hex('#C8FAFF', 180);

    // 沿弹道流动的液滴珠链（万能彩球整条射线变成流动七彩霓虹珠链）
    const spacing = 22;
    let phaseOffset = ((now * (65 + charge01 * 75)) % spacing);
    let accum = 0;
    let beadIdx = 0;
    for (let i = 1; i < pts.length; i++) {
      const x0 = pts[i - 1].x;
      const y0 = pts[i - 1].y;
      const x1 = pts[i].x;
      const y1 = pts[i].y;
      const seg = Math.hypot(x1 - x0, y1 - y0);
      if (seg < 0.5) continue;
      let d = spacing - ((accum - phaseOffset + spacing * 100) % spacing);
      while (d <= seg) {
        const t = d / seg;
        const bx = x0 + (x1 - x0) * t;
        const by = y0 + (y1 - y0) * t;
        const br = (isWild ? 5.2 : isMerge ? 4.4 : 3.4) + charge01 * 1.1;
        if (isWild) {
          const ci = (beadIdx + Math.floor(now * 10)) % rainbowPalette.length;
          g.fillColor = hex(rainbowPalette[ci], 245);
        } else {
          g.fillColor = beadColor;
        }
        g.circle(bx, by, br);
        g.fill();
        beadIdx++;
        d += spacing;
      }
      accum += seg;
    }

    // 落点半透明呼吸虚影（~50% 透明度 + 柔和浅青/金染色 + 呼吸缩放）与实心落定球明显区分
    const curVal = this.world.current ?? 2;
    const r = isWild ? 24 : RADIUS[curVal] ?? 18;
    const pulse = 0.5 + 0.5 * Math.sin(now * 9);
    const wildNowCol = hex(rainbowPalette[Math.floor(now * 7) % rainbowPalette.length], 240);
    g.fillColor = isWild ? hex('#FF9FF3', 42) : isMerge ? hex('#FFE066', 36) : hex('#9EF6FF', 28);
    g.circle(pred.hitX, pred.hitY, r);
    g.fill();

    const tipArt = isWild ? this.assets.ui.wild_orb : this.assets.ball(curVal)?.frame;
    if (tipArt) {
      const scale = isWild ? 2.5 : (this.assets.ball(curVal)?.displayScale ?? 1.1) * 2;
      const sz = Math.max(42, r * scale);
      const breath = 0.94 + pulse * 0.08;
      this.aimTipNode.active = true;
      this.aimTipSprite.spriteFrame = tipArt;
      this.aimTipSprite.color = isMerge ? hex('#FFF4B8') : isWild ? Color.WHITE : hex('#C8F7FF');
      this.aimTipNode.getComponent(UITransform)!.setContentSize(sz, sz);
      this.aimTipNode.setPosition(pred.hitX, pred.hitY, 0);
      this.aimTipNode.setScale(breath, breath, 1);
      this.aimTipNode.angle = isWild ? (now * 140) % 360 : 0;
      this.aimTipOp.opacity = Math.round((isMerge || isWild ? 148 : 124) + pulse * 30);
    } else {
      this.aimTipNode.active = false;
    }

    // 落点外圈「旋转虚线准星环 + 十字准星刻度」：与已落定的实心泡泡形成鲜明视觉反差
    const dashR = r + 4.5 + (isMerge || isWild ? pulse * 2.5 : 0);
    const segs = 10;
    const arcStep = (Math.PI * 2) / segs;
    const rotBase = now * 2.2;
    g.strokeColor = isWild ? wildNowCol : isMerge ? hex('#FFE066', 240) : hex('#BFF8FF', 210);
    g.lineWidth = isWild ? 3.2 : isMerge ? 3 : 2.4;
    for (let s = 0; s < segs; s++) {
      const a0 = rotBase + s * arcStep;
      const a1 = a0 + arcStep * 0.54;
      for (let j = 0; j <= 3; j++) {
        const a = a0 + ((a1 - a0) * j) / 3;
        const px = pred.hitX + Math.cos(a) * dashR;
        const py = pred.hitY + Math.sin(a) * dashR;
        if (j === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
    }
    g.stroke();

    // 4 向准星短刻度 + 合并/彩球扩散光波特效
    g.strokeColor = isWild ? wildNowCol : isMerge ? hex('#FFE87C', 220) : hex('#9EF6FF', 165);
    g.lineWidth = 2;
    for (let k = 0; k < 4; k++) {
      const ca = k * (Math.PI * 0.5);
      const c = Math.cos(ca);
      const s = Math.sin(ca);
      g.moveTo(pred.hitX + c * (dashR + 2), pred.hitY + s * (dashR + 2));
      g.lineTo(pred.hitX + c * (dashR + 8), pred.hitY + s * (dashR + 8));
    }
    g.stroke();

    if (isMerge || isWild) {
      const waveT = (now * 1.8) % 1;
      g.strokeColor = hex(isWild ? '#FF9FF3' : '#FFE066', Math.round((1 - waveT) * 175));
      g.lineWidth = 2.2;
      g.circle(pred.hitX, pred.hitY, r + 6 + waveT * 14);
      g.stroke();
    }

    // 若命中同数球或万能彩球锁定目标，给顶部目标球加双层脉冲锁定光环！
    let targetVal = 0;
    if (pred.targetBallId && isMerge) {
      const tv = this.views.get(pred.targetBallId);
      if (tv) {
        targetVal = tv.value;
        g.strokeColor = isWild ? wildNowCol : hex('#FFE066', Math.round(170 + pulse * 80));
        g.lineWidth = isWild ? 4.5 : 4;
        g.circle(tv.lastX, tv.lastY, tv.r + 5 + pulse * 4);
        g.stroke();
        if (isWild) {
          g.strokeColor = hex(rainbowPalette[(Math.floor(now * 7) + 3) % rainbowPalette.length], 220);
          g.lineWidth = 2.6;
          g.circle(tv.lastX, tv.lastY, tv.r + 12 + pulse * 5);
          g.stroke();
        }
      }
    }

    // 智能提示标：自动避让落点球体、目标球与射入弹道，绝不遮挡落点或场内数字
    const fullPierce = charge01 >= 0.96;
    const prevPt = pts[pts.length - 2];
    if (isMerge) {
      this.aimBadge.node.active = true;
      if (isWild && targetVal > 0) {
        this.aimBadge.string = targetVal >= 2048 ? '🌈 2048爆裂!' : `🌈 ${targetVal}→${targetVal * 2}!`;
        this.aimBadge.color = hex('#FFAEF8');
      } else {
        this.aimBadge.string = fullPierce ? '⚡ 穿透合并!' : '合并!';
        this.aimBadge.color = hex('#FFE87C');
      }
      this.aimBadgeOp.opacity = Math.round(215 + pulse * 40);
      this.placeAimBadge(pred.hitX, pred.hitY, r, pred.targetBallId, prevPt);
    } else if (fullPierce && this.aim.charging) {
      this.aimBadge.node.active = true;
      this.aimBadge.string = isWild ? '🌈 万能穿透' : '⚡ 高压穿透';
      this.aimBadge.color = isWild ? hex('#FFAEF8') : hex('#8FFFD4');
      this.aimBadgeOp.opacity = Math.round(210 + pulse * 45);
      this.placeAimBadge(pred.hitX, pred.hitY, r, pred.targetBallId, prevPt);
    } else {
      this.aimBadge.node.active = false;
    }
  }

  /** 将「合并! / ⚡ 高压穿透」提示放置在落点外围空白水域，避免被边界夹回并挡住数字 */
  private placeAimBadge(
    hitX: number,
    hitY: number,
    r: number,
    targetBallId?: number,
    prevPt?: { x: number; y: number },
  ): void {
    const padX = 86;
    const minY = 160;
    const maxY = TANK.height - 34;
    const sideDx = r + 62;
    const diagDy = -(r + 28);
    const dirRightFirst = prevPt ? prevPt.x <= hitX : hitX < TANK.width * 0.5;
    const candidates: { x: number; y: number; pref: number }[] = [
      { x: hitX + (dirRightFirst ? sideDx : -sideDx), y: hitY + diagDy, pref: 3 },
      { x: hitX + (dirRightFirst ? -sideDx : sideDx), y: hitY + diagDy, pref: 2 },
      { x: hitX, y: hitY - (r + 36), pref: 1 },
      { x: hitX, y: hitY + (r + 34), pref: 0 },
    ];

    let bestX = Math.max(padX, Math.min(TANK.width - padX, hitX));
    let bestY = Math.max(minY, hitY - (r + 36));
    let bestScore = -1e9;

    for (const c of candidates) {
      if (c.y < minY || c.y > maxY) continue;
      const cx = Math.max(padX, Math.min(TANK.width - padX, c.x));
      const cy = c.y;
      // 必须与落点圆心保持清晰径向或纵向净空，绝不压在落点数字上
      const distHit = Math.hypot(cx - hitX, cy - hitY);
      if (distHit < r + 34 && Math.abs(cy - hitY) < r + 26) continue;

      let score = c.pref * 12;
      for (const [, tv] of this.views) {
        if (!tv.node.active) continue;
        const d = Math.hypot(cx - tv.lastX, cy - tv.lastY);
        const minClear = tv.r + (tv.id === targetBallId ? 38 : 28);
        if (d < minClear) {
          score -= 800 + (minClear - d) * 10;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestX = cx;
        bestY = cy;
      }
    }
    this.aimBadge.node.setPosition(bestX, bestY, 0);
  }

  private drawFx(dt: number): void {
    if (this.particles.length === 0 && this.rings.length === 0) {
      if (this.fxDirty) {
        this.fxG.clear();
        this.fxDirty = false;
      }
      return;
    }
    this.fxDirty = true;
    const g = this.fxG;
    g.clear();
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy -= 170 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const t = Math.max(0, p.life / p.maxLife);
      this.tmpColor.set(p.color.r, p.color.g, p.color.b, Math.round(230 * t));
      g.fillColor = this.tmpColor;
      const rad = p.r * (0.45 + 0.55 * t);
      g.circle(p.x, p.y, rad);
      g.fill();
      if (p.stretch) {
        g.fillColor = new Color(255, 255, 255, Math.round(140 * t));
        g.circle(p.x - rad * 0.25, p.y + rad * 0.25, rad * 0.35);
        g.fill();
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      if (r.life <= 0) {
        this.rings.splice(i, 1);
        continue;
      }
      r.r += r.vr * dt;
      const t = Math.max(0, r.life / r.maxLife);
      this.tmpColor.set(r.color.r, r.color.g, r.color.b, Math.round(r.color.a * t));
      g.strokeColor = this.tmpColor;
      g.lineWidth = r.width * (0.5 + 0.5 * t);
      g.circle(r.x, r.y, r.r);
      g.stroke();
    }
  }

  private drawPopTexts(dt: number): void {
    for (const pt of this.popTexts) {
      if (!pt.active) continue;
      pt.life -= dt;
      if (pt.life <= 0) {
        pt.active = false;
        pt.node.active = false;
        continue;
      }
      const p = 1 - pt.life / pt.maxLife;
      pt.y += pt.vy * dt;
      pt.vy *= Math.exp(-2.4 * dt);
      pt.node.setPosition(pt.x, pt.y, 0);
      const pop = p < 0.18 ? 0.75 + (p / 0.18) * 0.45 : Math.max(0.95, 1.2 - (p - 0.18) * 0.3);
      pt.node.setScale(pop, pop, 1);
      pt.opacity.opacity = p > 0.55 ? Math.round(255 * Math.max(0, (1 - p) / 0.45)) : 255;
    }
  }
}
