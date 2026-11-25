/**
 * Liquid1024 · 水下浮力 1024 物理核心（纯 TS，无 Cocos 依赖）
 *
 * 玩法本质：1024 / 2048 数字合成 × 发射物理碰撞：
 * - 全场球体受向上水下浮力与流体阻尼，真实圆形弹性碰撞、挤推、滚动、绕缝；
 * - 取消随机乱扫力度条，瞄准线全程预测（含最多 2 次墙面反弹与目标锁定），松手稳定发射；
 * - 同数接触即合并翻倍（2→4→…→1024→2048），合并产生径向膨胀推力引发 2048 连消，绝不因断开顶框而消失；
 * - 球堆下压越过底部警戒线持续 1.5s 判负；保留排水 / 融化 / 磁铁三项液体道具与换球。
 */
import {
  RADIUS,
  TANK,
  cloneTuning,
  comboMultiplier,
  deepLineAt,
  deepSweepAt,
  depthMultiplier,
  launchSpeedForPower,
  makeRng,
  phaseIndexAt,
} from './Config';
import type { Tuning } from './Config';
import type { AimPrediction, Ball, RunResult, Shot, WorldEvent, WorldListener, WorldOptions } from './Types';

const EPS = 1e-6;
const CELEBRATE_1024 = 2.5;
const CELEBRATE_2048 = 3.0;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export class BallWorld {
  readonly tuning: Tuning;
  listener?: WorldListener;

  balls: Ball[] = [];
  /** 保留字段兼容旧接口；新物理中发射球直接进入 balls 参与真实碰撞 */
  shot: Shot | null = null;

  /** 当前装填 / 下一发预览 */
  current: number | null = null;
  next: number | null = null;
  currentWild = false;
  nextWild = false;

  score = 0;
  runTime = 0;
  worldTime = 0;
  lineY = 200;
  sweepPeriod = 1.2;
  sweepDistance = 0;

  currentPhase = 0;
  dangerTimer = 0;
  invuln = 0;
  cooldown = 0;

  mode: 'idle' | 'playing' | 'reviving' | 'defeated' = 'idle';
  slowPower = false;

  merges = 0;
  maxCombo = 0;
  maxBall = 2;
  detachedCount = 0;
  depth = 0;
  got1024 = false;
  got2048 = false;
  revived = false;
  reviveUsed = false;
  streak = 0;

  private rng: () => number;
  private nextId = 1;
  private combo = 0;
  private comboWindow = 0;
  private shotHadMerge = false;
  private firedActive = false;
  private swappedThisTurn = false;
  private highestAnnouncedTier = 32;
  private spawnCount = 0;
  private recentSpawns: number[] = [];
  private reloadTimer = -1;
  private lastShotBallId = 0;
  private shotClearTimer = 0;
  private celebration: { kind: 1024 | 2048; timer: number; duration: number; acted: boolean } | null = null;
  private reviveTimer = 0;
  private reviveWavesLeft = 0;
  private phaseAnnounced = -1;
  private sinceFire = 99;
  private lastCollideEmit = 0;
  private vortexCooldown = 40;
  private vortexTimer = 0;
  private vortexCx: number = TANK.width / 2;
  private vortexCy = 700;
  private lastIceMergeAt = 0;
  private tideCooldown = 40;
  private tideWave = 0;

  constructor(opts: WorldOptions) {
    this.tuning = cloneTuning(opts.tuning);
    this.listener = opts.listener;
    this.rng = makeRng(opts.seed ?? ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0));
  }

  // ---------------------------------------------------------------- 生命周期

  startRun(seed?: number): void {
    if (seed !== undefined) this.rng = makeRng(seed >>> 0);
    this.balls.length = 0;
    this.shot = null;
    this.current = null;
    this.next = null;
    this.currentWild = false;
    this.nextWild = false;
    this.score = 0;
    this.runTime = 0;
    this.worldTime = 0;
    this.sweepDistance = 0;
    this.dangerTimer = 0;
    this.invuln = 0;
    this.cooldown = 0;
    this.mode = 'playing';
    this.merges = 0;
    this.maxCombo = 0;
    this.maxBall = 2;
    this.detachedCount = 0;
    this.depth = 0;
    this.got1024 = false;
    this.got2048 = false;
    this.revived = false;
    this.reviveUsed = false;
    this.combo = 0;
    this.comboWindow = 0;
    this.shotHadMerge = false;
    this.firedActive = false;
    this.swappedThisTurn = false;
    this.highestAnnouncedTier = 32;
    this.streak = 0;
    this.spawnCount = 0;
    this.recentSpawns = [];
    this.reloadTimer = -1;
    this.lastShotBallId = 0;
    this.shotClearTimer = 0;
    this.celebration = null;
    this.reviveTimer = 0;
    this.reviveWavesLeft = 0;
    this.phaseAnnounced = -1;
    this.sinceFire = 99;
    this.lastCollideEmit = 0;
    this.vortexCooldown = 40;
    this.vortexTimer = 0;
    this.vortexCx = TANK.width / 2;
    this.vortexCy = 700;
    this.lastIceMergeAt = 0;
    this.tideCooldown = 22;
    this.tideWave = 0;
    this.nextId = 1;
    this.buildStarterStack();
    this.current = this.drawSpawn();
    this.next = this.drawSpawn();
    this.currentPhase = 0;
    this.lineY = deepLineAt(0, this.tuning);
    this.sweepPeriod = deepSweepAt(0, this.tuning);
    this.emit({ type: 'loaded', current: this.current, next: this.next });
  }

  restart(): void {
    this.startRun();
  }

  finishRun(reason: 'line' | 'hardcap' = 'hardcap'): void {
    if (this.mode === 'defeated') return;
    this.mode = 'defeated';
    this.shot = null;
    this.emit({ type: 'defeat', reason, score: this.score });
    this.emit({ type: 'result', result: this.result(reason) });
  }

  result(reason: 'line' | 'hardcap' = 'hardcap'): RunResult {
    return {
      score: this.score,
      merges: this.merges,
      maxCombo: this.maxCombo,
      maxBall: this.maxBall,
      depth: this.depth,
      detached: this.detachedCount,
      time: this.runTime,
      reason,
      revived: this.revived,
      got1024: this.got1024,
      got2048: this.got2048,
    };
  }

  // ---------------------------------------------------------------- 输入 / 换球 / 装填

  getPower(): number {
    return 100;
  }

  getAimFanDeg(): number {
    return this.tuning.aimFanDeg;
  }

  isFever(): boolean {
    return this.streak >= 3;
  }

  getVortexState(): { active: boolean; cx: number; cy: number; remain: number } {
    return { active: this.vortexTimer > 0, cx: this.vortexCx, cy: this.vortexCy, remain: Math.max(0, this.vortexTimer) };
  }

  getTideState(): { countdown: number; wave: number; warning: boolean } {
    return {
      countdown: Math.max(0, this.tideCooldown),
      wave: this.tideWave,
      warning: this.mode === 'playing' && this.tideCooldown > 0 && this.tideCooldown <= 4.0,
    };
  }

  canSwap(): boolean {
    return (
      this.mode === 'playing' &&
      !this.celebration &&
      this.current !== null &&
      this.next !== null &&
      !this.swappedThisTurn &&
      (this.current !== this.next || this.currentWild !== this.nextWild)
    );
  }

  swapCurrentNext(): boolean {
    if (!this.canSwap()) return false;
    const tmp = this.current!;
    this.current = this.next!;
    this.next = tmp;
    const tmpW = this.currentWild;
    this.currentWild = this.nextWild;
    this.nextWild = tmpW;
    this.swappedThisTurn = true;
    this.emit({ type: 'swap', current: this.current, next: this.next });
    this.emit({ type: 'loaded', current: this.current, next: this.next });
    return true;
  }

  /** angleDeg：0=正上方，正=向右；power ∈ [0,100] 控制按住蓄力初速 */
  fire(angleDeg: number, power = 100): boolean {
    if (this.mode !== 'playing' || this.celebration || this.current === null) return false;
    const half = this.tuning.aimFanDeg / 2;
    const a = clamp(angleDeg, -half, half);
    const rad = (a * Math.PI) / 180;
    const p = clamp(power, 20, 100);
    const speed = launchSpeedForPower(p);
    const value = this.current;
    const isWild = this.currentWild;
    const isPiercing = p >= 95;
    const r = isWild ? 24 : RADIUS[value];

    // 每发推进潮汐计时；若上一发未发生任何合并则重置连合，并大幅提前潮汐涌入
    let tideStep = 2.0;
    if (this.firedActive && !this.shotHadMerge) {
      if (this.streak > 0) {
        this.streak = 0;
        this.emit({ type: 'streak', streak: 0, fever: false });
      }
      tideStep = 5.0;
    }
    this.tideCooldown = Math.max(0.4, this.tideCooldown - tideStep);

    const ball: Ball = {
      id: this.nextId++,
      value,
      r,
      x: TANK.muzzleX,
      y: TANK.muzzleY,
      vx: Math.sin(rad) * speed,
      vy: Math.cos(rad) * speed,
      state: 'stack',
      anchored: false,
      age: 0,
      wobblePhase: this.rng() * Math.PI * 2,
      fallVx: 0,
      fallVy: 0,
      bornAt: this.worldTime,
      launchedAt: this.worldTime,
      mergeLockUntil: 0,
      wild: isWild,
      pierceUntil: isPiercing ? this.worldTime + 0.36 : 0,
    };
    this.balls.push(ball);
    this.lastShotBallId = ball.id;
    this.shotClearTimer = 0.28;
    this.current = null;
    this.currentWild = false;
    this.combo = 0;
    this.comboWindow = 0.75;
    this.shotHadMerge = false;
    this.firedActive = true;
    this.sinceFire = 0;
    this.reloadTimer = 0.26;
    this.emit({ type: 'fire', x: ball.x, y: ball.y, angle: a, power: p, speed, value, ballId: ball.id });
    return true;
  }

  /** 完整弹道预览：匹配按住蓄力初速、轻阻尼、向上浮力及最多 2 次墙面反弹 */
  predictAim(angleDeg: number, power = 100, maxLen: number = TANK.aimLineLen, maxBounces = 2): AimPrediction {
    const half = this.tuning.aimFanDeg / 2;
    const a = clamp(angleDeg, -half, half);
    const rad = (a * Math.PI) / 180;
    const curVal = this.current ?? 2;
    const curR = this.currentWild ? 24 : RADIUS[curVal] ?? 18;
    const speed0 = launchSpeedForPower(clamp(power, 20, 100));
    let x: number = TANK.muzzleX;
    let y: number = TANK.muzzleY;
    let vx: number = Math.sin(rad) * speed0;
    let vy: number = Math.cos(rad) * speed0;
    const pts: { x: number; y: number }[] = [{ x, y }];
    let travelled = 0;
    let bounces = 0;
    let hitKind: AimPrediction['hitKind'] = 'none';
    let targetBallId: number | undefined;

    const dt = 1 / 120;
    for (let i = 0; i < 240 && travelled < maxLen; i++) {
      const damp = Math.exp(-TANK.flightDrag * dt);
      vx *= damp;
      vy = vy * damp + TANK.buoyancy * dt;
      const nx = x + vx * dt;
      const ny = y + vy * dt;
      travelled += hypot(nx - x, ny - y);
      x = nx;
      y = ny;

      if (y + curR >= TANK.topY) {
        y = TANK.topY - curR;
        pts.push({ x, y });
        hitKind = 'top';
        break;
      }
      if (x - curR < 0) {
        x = curR;
        vx = Math.abs(vx) * 0.68;
        pts.push({ x, y });
        bounces++;
        if (bounces > maxBounces) break;
      } else if (x + curR > TANK.width) {
        x = TANK.width - curR;
        vx = -Math.abs(vx) * 0.68;
        pts.push({ x, y });
        bounces++;
        if (bounces > maxBounces) break;
      }

      let hitBall: Ball | null = null;
      let bestD = Infinity;
      for (const b of this.balls) {
        if (b.state !== 'stack') continue;
        const dx = x - b.x;
        const dy = y - b.y;
        const rr = b.r + curR;
        const d2 = dx * dx + dy * dy;
        if (d2 <= rr * rr && d2 < bestD) {
          bestD = d2;
          hitBall = b;
        }
      }
      if (hitBall) {
        pts.push({ x, y });
        targetBallId = hitBall.id;
        const canDirectMerge =
          !hitBall.iced && (this.currentWild || (hitBall.value === curVal && hitBall.value * 2 <= 2048));
        hitKind = canDirectMerge ? 'merge' : 'stick';
        break;
      }
      if (pts.length === 1 || hypot(x - pts[pts.length - 1].x, y - pts[pts.length - 1].y) > 8) {
        pts.push({ x, y });
      }
    }
    const end = pts[pts.length - 1];
    return { pts, hitKind, hitX: end.x, hitY: end.y, targetBallId };
  }

  predictPath(angleDeg: number, power = 100, maxLen: number = TANK.aimLineLen, maxBounces = 2): { x: number; y: number }[] {
    return this.predictAim(angleDeg, power, maxLen, maxBounces).pts;
  }

  // ---------------------------------------------------------------- 主循环与物理

  update(rawDt: number): void {
    if (this.mode === 'idle' || this.mode === 'defeated') return;
    const dt = Math.min(0.05, Math.max(0, rawDt));
    if (dt <= 0) return;
    this.worldTime += dt;
    this.sinceFire += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.shotClearTimer = Math.max(0, this.shotClearTimer - dt);
    if (this.comboWindow > 0) {
      this.comboWindow -= dt;
      if (this.comboWindow <= 0) this.combo = 0;
    }

    this.runTime += dt;
    this.updatePhase();

    if (this.mode === 'reviving') {
      this.updateRevive(dt);
      this.updateFalling(dt);
      return;
    }

    let simDt = dt;
    if (this.celebration) {
      const c = this.celebration;
      c.timer -= dt;
      simDt = dt * 0.25;
      if (c.kind === 1024 && !c.acted && c.timer <= c.duration - 1.25) {
        c.acted = true;
        this.removeLowest(5, 0, 'celebrate', 1024);
      }
      if (c.timer <= 0) {
        this.emit({ type: 'celebrateEnd', kind: c.kind });
        this.celebration = null;
        simDt = dt;
      }
    }

    this.sweepPeriod = deepSweepAt(this.runTime, this.tuning);
    this.sweepDistance += dt / this.sweepPeriod;

    if (this.mode === 'playing') {
      if (this.vortexTimer > 0) {
        this.vortexTimer = Math.max(0, this.vortexTimer - simDt);
        if (this.vortexTimer <= 0) {
          this.emit({ type: 'vortex', active: false, cx: this.vortexCx, cy: this.vortexCy });
        }
      } else {
        this.vortexCooldown -= simDt;
        if (this.vortexCooldown <= 0) {
          this.vortexCooldown = 44;
          this.vortexTimer = 5.5;
          this.vortexCx = 200 + this.rng() * (TANK.width - 400);
          this.vortexCy = 680 + this.rng() * 140;
          this.emit({ type: 'vortex', active: true, cx: this.vortexCx, cy: this.vortexCy });
        }
      }
      // 顶部深海潮汐涌球：时间 + 发数混合驱动，低阶杂球与薄冰压顶并逐步抬升警戒线
      this.tideCooldown -= simDt;
      if (this.tideCooldown <= 0) {
        this.tideWave++;
        this.tideCooldown = Math.max(8, 15 - this.tideWave * 0.45);
        this.spawnTideRow();
      }
    }

    this.stepPhysics(simDt);
    this.updateFalling(simDt);

    // 发射球离开炮口区域后自动装填下一发
    if (this.current === null && this.next !== null && this.mode === 'playing') {
      const flying = this.balls.find((b) => b.id === this.lastShotBallId && b.state === 'stack');
      const clearOfMuzzle = !flying || flying.y - flying.r > TANK.muzzleY + 75;
      if (this.reloadTimer > 0) this.reloadTimer -= simDt;
      if (this.reloadTimer <= 0 && clearOfMuzzle) {
        this.reload();
      }
    }

    if (this.mode === 'playing' && !this.celebration) this.updateDanger(dt);
  }

  private spawnTideRow(): void {
    const slots =
      this.tideWave >= 2
        ? [68, 176, 284, 392, 500, 608]
        : [88, 214, 340, 466, 592];
    const pattern = this.maxBall >= 256 ? [4, 8, 16, 4, 8, 16] : [2, 4, 8, 2, 4, 8];
    for (const existing of this.balls) {
      if (existing.state === 'stack' && existing.y > TANK.topY - 260) {
        existing.vy -= 210;
      }
    }
    let spawned = 0;
    const icedCount = this.balls.filter((x) => x.state === 'stack' && x.iced).length;
    let addedIce = 0;
    const maxIceThisWave = this.tideWave >= 2 ? 2 : 1;
    for (let i = 0; i < slots.length; i++) {
      const sx = slots[i];
      const val = pattern[(i + this.tideWave) % pattern.length];
      const r = RADIUS[val] ?? 18;
      const b = this.createBall(
        val,
        sx + (this.rng() - 0.5) * 14,
        TANK.topY - r - 4,
        (this.rng() - 0.5) * 28,
        -155,
      );
      if (b) {
        const iceChance = this.tideWave >= 3 ? 0.52 : 0.3;
        if (icedCount + addedIce < 5 && addedIce < maxIceThisWave && this.rng() < iceChance) {
          b.iced = true;
          addedIce++;
        }
        this.balls.push(b);
        spawned++;
      }
    }
    if (spawned > 0) {
      this.emit({ type: 'tide', count: spawned, wave: this.tideWave });
    }
  }

  private updatePhase(): void {
    const idx = phaseIndexAt(this.runTime);
    this.lineY = this.tuning.lineY;
    if (idx !== this.phaseAnnounced) {
      this.phaseAnnounced = idx;
      this.currentPhase = idx;
      this.emit({ type: 'phase', index: idx, lineY: this.lineY, sweepPeriod: deepSweepAt(this.runTime, this.tuning) });
    }
  }

  private updateDanger(dt: number): void {
    if (this.invuln > 0) {
      this.dangerTimer = 0;
      return;
    }
    let minBottom = Infinity;
    for (const b of this.balls) {
      if (b.state !== 'stack') continue;
      // 刚发射上升中的球 1.0s 内不触发越线，避免炮口附近误判
      if (b.launchedAt > 0 && this.worldTime - b.launchedAt < 1.0) continue;
      const sp = hypot(b.vx, b.vy);
      if (sp > 320) continue;
      const bottom = b.y - b.r;
      if (bottom < minBottom) minBottom = bottom;
    }
    if (minBottom < this.lineY) {
      this.dangerTimer += dt;
      if (this.dangerTimer >= 1.5) {
        this.finishRun('line');
      }
    } else {
      this.dangerTimer = Math.max(0, this.dangerTimer - dt * 2.4);
    }
  }

  private reload(): void {
    this.reloadTimer = -1;
    this.swappedThisTurn = false;
    this.current = this.next;
    this.currentWild = this.nextWild;
    this.next = this.drawSpawn();
    this.nextWild = false;
    this.emit({ type: 'reload' });
    this.emit({ type: 'loaded', current: this.current ?? 2, next: this.next ?? 2 });
  }

  /**
   * 6 子步水下软体浮力物理：
   * - 向上浮力使球自然聚拢并向上浮起；
   * - 真实圆-圆弹性软体碰撞、动量交换、切向绕缝滑入；
   * - 同数相撞合并，释放膨胀推力引发 1024/2048 连锁。
   */
  private stepPhysics(dt: number): void {
    const stack: Ball[] = [];
    for (const b of this.balls) if (b.state === 'stack') stack.push(b);
    const n = stack.length;
    if (n === 0) return;

    const substeps = n > 140 ? 3 : 6;
    const h = dt / substeps;
    const mergesToRun: [Ball, Ball][] = [];
    const mergedIds = new Set<number>();

    for (let step = 0; step < substeps; step++) {
      // 1. 外力（水下浮力 + 流体阻尼）与位置积分
      for (let i = 0; i < n; i++) {
        const b = stack[i];
        b.age += h;
        const isInitialFlight = b.launchedAt > 0 && this.worldTime - b.launchedAt < 0.42;
        const drag = isInitialFlight ? TANK.flightDrag : TANK.waterDrag;
        const damp = Math.exp(-drag * h);
        b.vx *= damp;
        b.vy = b.vy * damp + TANK.buoyancy * h;
        if (this.vortexTimer > 0) {
          const vdx = this.vortexCx - b.x;
          const vdy = Math.min(TANK.topY - 80, this.vortexCy + 60) - b.y;
          const vd = hypot(vdx, vdy);
          if (vd > 12 && vd < 340) {
            const pull = (1 - vd / 340) * 190;
            b.vx += ((vdx / vd) * pull - (vdy / vd) * (pull * 0.45)) * h;
            b.vy += ((vdy / vd) * pull + (vdx / vd) * (pull * 0.45)) * h;
          }
        }

        // 限制极高速度，保证隧道穿透可控
        const sp = hypot(b.vx, b.vy);
        if (sp > 2200) {
          const k = 2200 / sp;
          b.vx *= k;
          b.vy *= k;
        }
        b.x += b.vx * h;
        b.y += b.vy * h;

        // 墙面反弹
        if (b.x - b.r < 0) {
          b.x = b.r;
          if (b.vx < 0) {
            const impact = Math.abs(b.vx);
            b.vx = impact * 0.68;
            if (impact > 200 && step === 0) this.emit({ type: 'bounce', x: b.x, y: b.y, wall: 'left', ballId: b.id });
          }
        } else if (b.x + b.r > TANK.width) {
          b.x = TANK.width - b.r;
          if (b.vx > 0) {
            const impact = Math.abs(b.vx);
            b.vx = -impact * 0.68;
            if (impact > 200 && step === 0) this.emit({ type: 'bounce', x: b.x, y: b.y, wall: 'right', ballId: b.id });
          }
        }
        if (b.y + b.r > TANK.topY) {
          b.y = TANK.topY - b.r;
          if (b.vy > 0) {
            b.vy = -Math.abs(b.vy) * 0.25;
            if (b.id === this.lastShotBallId) b.launchedAt = 0;
          }
        } else if (b.y - b.r < 0) {
          b.y = b.r;
          if (b.vy < 0) b.vy = Math.abs(b.vy) * 0.35;
        }
      }

      // 2. 球-球圆形碰撞与合并检测
      for (let i = 0; i < n; i++) {
        const a = stack[i];
        if (mergedIds.has(a.id)) continue;
        for (let j = i + 1; j < n; j++) {
          const b = stack[j];
          if (mergedIds.has(b.id)) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const minD = a.r + b.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= minD * minD) continue;

          // 冰封气泡拦截与破冰判定
          const aPierce = !!(a.pierceUntil && this.worldTime < a.pierceUntil);
          const bPierce = !!(b.pierceUntil && this.worldTime < b.pierceUntil);
          const d = Math.sqrt(d2);
          const nx = d > EPS ? dx / d : 0;
          const ny = d > EPS ? dy / d : 1;
          const rvx = b.vx - a.vx;
          const rvy = b.vy - a.vy;
          const vn = rvx * nx + rvy * ny;
          const impact = vn < 0 ? -vn : 0;

          if (a.iced || b.iced) {
            const canCrack = impact > 160 || aPierce || bPierce || !!(a.wild || b.wild);
            if (canCrack) {
              if (a.iced) {
                a.iced = false;
                this.score += 30;
                this.emit({ type: 'iceBreak', x: a.x, y: a.y, value: a.value });
              }
              if (b.iced) {
                b.iced = false;
                this.score += 30;
                this.emit({ type: 'iceBreak', x: b.x, y: b.y, value: b.value });
              }
            }
          }

          // 同数或万能彩球碰撞且冷却结束（冰封已破或满力/彩球直破） → 加入合并队列
          const canWildMerge = !!(a.wild || b.wild);
          if (
            !a.iced &&
            !b.iced &&
            (canWildMerge || a.value === b.value) &&
            a.value <= 2048 &&
            b.value <= 2048 &&
            this.worldTime >= a.mergeLockUntil &&
            this.worldTime >= b.mergeLockUntil
          ) {
            mergedIds.add(a.id);
            mergedIds.add(b.id);
            mergesToRun.push([a, b]);
            continue;
          }

          // 满力高压穿透击：强力推开挡路小球，穿透球保留大部分向内冲量
          const overlap = minD - d;
          if ((aPierce && !bPierce) || (bPierce && !aPierce)) {
            const piercer = aPierce ? a : b;
            const blocker = aPierce ? b : a;
            const pnx = aPierce ? nx : -nx;
            const pny = aPierce ? ny : -ny;
            piercer.x -= pnx * overlap * 0.16;
            piercer.y -= pny * overlap * 0.16;
            blocker.x += pnx * overlap * 0.84;
            blocker.y += pny * overlap * 0.84;
            const latSign = blocker.x >= piercer.x ? 1 : -1;
            blocker.vx += (pnx * 260 + -pny * 190 * latSign);
            blocker.vy += (pny * 260 + pnx * 190 * latSign);
            piercer.vx *= 0.92;
            piercer.vy *= 0.92;
            continue;
          }

          // 不同数 → 真实弹性软体碰撞 & 挤推
          const invMa = 1 / (a.r * a.r);
          const invMb = 1 / (b.r * b.r);
          const invSum = invMa + invMb;

          // 软体略微允许 0.86 倍位置回弹，防止硬震颤
          const corr = (overlap * 0.86) / invSum;
          a.x -= nx * corr * invMa;
          a.y -= ny * corr * invMa;
          b.x += nx * corr * invMb;
          b.y += ny * corr * invMb;

          if (vn < 0) {
            // 接触后即切换为水阻尼结算状态
            if (a.id === this.lastShotBallId && impact > 140) a.launchedAt = 0;
            if (b.id === this.lastShotBallId && impact > 140) b.launchedAt = 0;

            const rest = impact > 350 ? 0.42 : 0.28;
            const imp = (-(1 + rest) * vn) / invSum;
            a.vx -= imp * invMa * nx;
            a.vy -= imp * invMa * ny;
            b.vx += imp * invMb * nx;
            b.vy += imp * invMb * ny;

            if (impact > 180 && this.worldTime - this.lastCollideEmit > 0.03) {
              this.lastCollideEmit = this.worldTime;
              this.emit({
                type: 'collide',
                x: a.x + nx * a.r,
                y: a.y + ny * a.r,
                aId: a.id,
                bId: b.id,
                nx,
                ny,
                speed: impact,
              });
            }
          }
        }
      }
    }

    // 3. 提交本帧检测到的合并（按链式反应执行）
    for (const [a, b] of mergesToRun) {
      if (this.balls.indexOf(a) >= 0 && this.balls.indexOf(b) >= 0) {
        this.mergePair(a, b);
      }
    }
  }

  private mergePair(a: Ball, b: Ball): void {
    const baseVal = a.wild && !b.wild ? b.value : b.wild && !a.wild ? a.value : Math.max(a.value, b.value);
    // 2048 + 2048（或万能球撞 2048）：终极金色爆裂清场，腾出大空间继续无限冲分
    if (baseVal === 2048) {
      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      this.removeBall(a, 'merge', false);
      this.removeBall(b, 'merge', false);
      this.combo++;
      this.comboWindow = 0.78;
      this.merges++;
      this.depth++;
      const gain = Math.round(30000 * comboMultiplier(this.combo, this.tuning));
      this.score += gain;
      this.emit({ type: 'depth', depth: this.depth, multiplier: depthMultiplier(this.depth, this.tuning) });
      this.emit({ type: 'first2048', x: mx, y: my, score: gain });
      this.emit({ type: 'tier', value: 2048, x: mx, y: my });
      return;
    }
    const value = baseVal * 2;
    if (!RADIUS[value]) return;
    const isChain = this.combo >= 1;
    // 偏向质量更稳定/更靠上的球中心，但保留一点动量合成感
    const spA = hypot(a.vx, a.vy);
    const spB = hypot(b.vx, b.vy);
    const wA = spA > spB * 1.4 ? 0.38 : 0.5;
    const mx = a.x * wA + b.x * (1 - wA);
    const my = a.y * wA + b.y * (1 - wA);
    const mvx = (a.vx + b.vx) * 0.45;
    const mvy = (a.vy + b.vy) * 0.45 + 35;

    this.removeBall(a, 'merge', false);
    this.removeBall(b, 'merge', false);

    this.combo++;
    this.comboWindow = 0.78;
    const newBall = this.createBall(value, mx, my, mvx, mvy);
    if (!newBall) return;
    newBall.mergeLockUntil = this.worldTime + 0.08;
    this.balls.push(newBall);

    // 合并膨胀冲击波：把邻球轻轻推开，促成下一拍连消！
    const pushReach = newBall.r + 120;
    for (const other of this.balls) {
      if (other.state !== 'stack' || other.id === newBall.id) continue;
      const dx = other.x - newBall.x;
      const dy = other.y - newBall.y;
      const d = hypot(dx, dy);
      if (d > EPS && d < pushReach) {
        const falloff = 1 - d / pushReach;
        const imp = (110 + Math.min(120, Math.log2(value) * 14)) * falloff;
        other.vx += (dx / d) * imp;
        other.vy += (dy / d) * imp;
      }
    }

    this.merges++;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    if (value > this.maxBall) this.maxBall = value;

    if (this.firedActive && !this.shotHadMerge) {
      this.shotHadMerge = true;
      this.streak++;
      this.emit({ type: 'streak', streak: this.streak, fever: this.isFever() });
      if (this.streak > 0 && this.streak % 8 === 0 && !this.nextWild && !this.currentWild) {
        this.nextWild = true;
        this.emit({ type: 'wildReady' });
      }
    }
    // 中后期每隔 12 次合成偶发 1 颗薄冰球，最多同时 2 颗
    if (this.merges >= 16 && this.merges - this.lastIceMergeAt >= 12) {
      const icedCount = this.balls.filter((x) => x.state === 'stack' && x.iced).length;
      if (icedCount < 2) {
        const candidates = this.balls.filter(
          (x) =>
            x.state === 'stack' &&
            x.id !== newBall.id &&
            !x.iced &&
            !x.wild &&
            x.value >= 2 &&
            x.value <= 32 &&
            x.y > this.lineY + 260,
        );
        if (candidates.length > 0) {
          const pick = candidates[Math.floor(this.rng() * candidates.length)];
          pick.iced = true;
          this.lastIceMergeAt = this.merges;
        }
      }
    }
    if (this.firedActive && value > this.highestAnnouncedTier && value < 1024) {
      this.highestAnnouncedTier = value;
      this.emit({ type: 'tier', value, x: newBall.x, y: newBall.y });
    }

    let depthMult = depthMultiplier(this.depth, this.tuning);
    if (value === 1024) {
      if (!this.got1024) {
        this.got1024 = true;
        this.depth = 0;
        this.score += this.tuning.first1024;
        this.startCelebration(1024);
        this.emit({ type: 'first1024', x: newBall.x, y: newBall.y, score: this.tuning.first1024 });
      } else {
        this.depth++;
        depthMult = depthMultiplier(this.depth, this.tuning);
        this.emit({ type: 'depth', depth: this.depth, multiplier: depthMult });
      }
    } else if (value === 2048) {
      if (!this.got2048) {
        this.got2048 = true;
        this.score += this.tuning.first2048;
        this.startCelebration(2048);
        this.emit({ type: 'first2048', x: newBall.x, y: newBall.y, score: this.tuning.first2048 });
      }
    }

    const mult = comboMultiplier(this.combo, this.tuning) * depthMult;
    const feverMult = this.firedActive && this.isFever() ? 1.2 : 1;
    const gain = Math.round(value * this.tuning.basePerValue * mult * feverMult);
    this.score += gain;
    this.emit({
      type: 'merge',
      x: newBall.x,
      y: newBall.y,
      value,
      score: gain,
      combo: this.combo,
      squeezed: false,
      chain: isChain,
      ball: newBall,
      streak: this.streak,
      fever: this.isFever(),
    });
  }

  private startCelebration(_kind: 1024 | 2048): void {
    // 非阻塞里程碑庆祝：不锁死操作，不打断无限对局节奏
    void _kind;
  }

  private updateFalling(dt: number): void {
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.age += dt;
      if (b.state !== 'falling') continue;
      b.y += b.fallVy * dt;
      b.x += b.fallVx * dt;
      b.fallVy -= 12 * dt;
      b.wobblePhase += dt * 2;
      if (b.removeReason) {
        b.age += dt * 1.5;
        if (b.age > 0.55) {
          this.balls.splice(i, 1);
          this.emit({ type: 'remove', id: b.id, reason: b.removeReason });
          continue;
        }
      }
      if (b.y + b.r < -20 || b.x < -b.r - 30 || b.x > TANK.width + b.r + 30) {
        this.balls.splice(i, 1);
        this.emit({ type: 'remove', id: b.id, reason: 'fall' });
      }
    }
  }

  // ---------------------------------------------------------------- 道具 / 复活

  canUseItem(): boolean {
    return this.mode === 'playing' && !this.celebration && this.cooldown <= 0 && this.sinceFire >= 0.25;
  }

  useDrain(): number {
    if (!this.canUseItem()) return -1;
    this.cooldown = 0.6;
    const removed = this.removeLowest(this.tuning.drainCount, this.tuning.drainScore, 'drain');
    this.emit({ type: 'item', kind: 'drain', removed });
    return removed;
  }

  useMelt(ballId: number): boolean {
    if (!this.canUseItem()) return false;
    const b = this.balls.find((x) => x.id === ballId && x.state === 'stack');
    if (!b) return false;
    this.cooldown = 0.6;
    this.detachBall(b, 'melt');
    this.emit({ type: 'remove', id: b.id, reason: 'melt' });
    this.emit({ type: 'item', kind: 'melt', removed: 1 });
    return true;
  }

  useMagnet(ballId: number): number {
    if (!this.canUseItem()) return -1;
    const target = this.balls.find((x) => x.id === ballId && x.state === 'stack');
    if (!target) return -1;
    this.cooldown = 0.6;
    const same = this.balls
      .filter((x) => x.state === 'stack' && x.value === target.value)
      .sort((a, b) => a.y - a.r - (b.y - b.r))
      .slice(0, this.tuning.magnetMax);
    let removed = 0;
    for (const b of same) {
      this.detachBall(b, 'magnet');
      this.emit({ type: 'remove', id: b.id, reason: 'magnet' });
      removed++;
    }
    this.score += removed * target.value * this.tuning.magnetScoreFactor;
    this.emit({ type: 'item', kind: 'magnet', removed });
    return removed;
  }

  private removeLowest(n: number, scorePer: number, reason: 'drain' | 'celebrate', excludeValue?: number): number {
    const candidates = this.balls
      .filter((b) => b.state === 'stack' && (excludeValue === undefined || b.value !== excludeValue))
      .sort((a, b) => a.y - a.r - (b.y - b.r));
    const take = candidates.slice(0, Math.max(0, n));
    for (const b of take) {
      this.detachBall(b, reason);
      this.emit({ type: 'remove', id: b.id, reason });
    }
    if (scorePer > 0) this.score += take.length * scorePer;
    return take.length;
  }

  private detachBall(b: Ball, reason: 'drain' | 'melt' | 'magnet' | 'celebrate'): void {
    b.state = 'falling';
    b.removeReason = reason;
    b.age = 0;
    b.fallVx = (this.rng() - 0.5) * 40;
    b.fallVy = -160 - this.rng() * 90;
  }

  private removeBall(b: Ball, reason: string, emit: boolean): void {
    const idx = this.balls.indexOf(b);
    if (idx >= 0) this.balls.splice(idx, 1);
    if (emit) this.emit({ type: 'remove', id: b.id, reason: 'fall' });
  }

  revive(): boolean {
    if (!this.reviveUsed) {
      this.reviveUsed = true;
      this.revived = true;
      this.mode = 'reviving';
      this.dangerTimer = 0;
      this.invuln = 1.5;
      this.reviveTimer = 0;
      this.reviveWavesLeft = Math.max(2, Math.round(this.tuning.reviveSeconds));
      if (this.current === null) {
        this.current = this.next;
        this.next = this.drawSpawn();
      }
      this.emit({ type: 'reviveStart', waves: this.reviveWavesLeft });
      return true;
    }
    return false;
  }

  private updateRevive(dt: number): void {
    this.reviveTimer += dt;
    if (this.reviveTimer >= 1) {
      this.reviveTimer -= 1;
      const removed = this.removeLowest(this.tuning.revivePerSecond, 0, 'drain');
      this.reviveWavesLeft--;
      this.emit({ type: 'reviveWave', count: removed });
      if (this.reviveWavesLeft <= 0) {
        this.mode = 'playing';
        this.dangerTimer = 0;
        this.invuln = 1.5;
        this.emit({ type: 'reviveEnd' });
      }
    }
  }

  // ---------------------------------------------------------------- 查询 / 调参

  getDangerLevel(): number {
    return clamp(this.dangerTimer / 1.5, 0, 1);
  }

  getMinBottom(): number {
    let m = Infinity;
    for (const b of this.balls) {
      if (b.state !== 'stack') continue;
      if (b.launchedAt > 0 && this.worldTime - b.launchedAt < 1.0) continue;
      if (b.y - b.r < m) m = b.y - b.r;
    }
    return m === Infinity ? TANK.topY : m;
  }

  getStackCount(): number {
    let n = 0;
    for (const b of this.balls) if (b.state === 'stack') n++;
    return n;
  }

  getTotalCount(): number {
    return this.balls.length;
  }

  getCombo(): number {
    return this.combo;
  }

  isInputLocked(): boolean {
    return this.mode !== 'playing' || !!this.celebration;
  }

  isChainPending(): boolean {
    for (const b of this.balls) {
      if (b.state === 'stack' && hypot(b.vx, b.vy) > 120) return true;
    }
    return false;
  }

  ballAt(x: number, y: number): Ball | null {
    let best: Ball | null = null;
    let bestD = Infinity;
    for (const b of this.balls) {
      if (b.state !== 'stack') continue;
      const d = hypot(x - b.x, y - b.y);
      if (d <= b.r + 12 && d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  applyTuning(t: Tuning): void {
    Object.assign(this.tuning, t);
    this.lineY = deepLineAt(this.runTime, this.tuning);
    this.sweepPeriod = deepSweepAt(this.runTime, this.tuning);
  }

  enableSlowPower(): void {
    this.slowPower = true;
  }

  debugAddBall(value: number, x: number, y: number, anchored = false): Ball | null {
    const r = RADIUS[value];
    if (!r) return null;
    const ball: Ball = {
      id: this.nextId++,
      value,
      r,
      x: clamp(x, r + 1, TANK.width - r - 1),
      y: clamp(y, r + 1, TANK.topY - r),
      vx: 0,
      vy: 0,
      state: 'stack',
      anchored,
      age: 0,
      wobblePhase: this.rng() * Math.PI * 2,
      fallVx: 0,
      fallVy: 0,
      bornAt: this.worldTime,
      launchedAt: 0,
      mergeLockUntil: 0,
    };
    this.balls.push(ball);
    return ball;
  }

  debugClear(): void {
    this.balls.length = 0;
    this.shot = null;
    this.dangerTimer = 0;
  }

  debugScore(n: number): void {
    this.score += n;
  }

  debugSettle(): void {
    // 步进一小段物理让场内球碰撞/合并收敛
    for (let i = 0; i < 30; i++) this.stepPhysics(1 / 60);
  }

  debugMergePair(value: number): void {
    if (value > 2048) return;
    const r = RADIUS[value];
    if (!r) return;
    const a = this.debugAddBall(value, 310, 900);
    const b = this.debugAddBall(value, 310 + r * 1.5, 900);
    if (a && b) this.mergePair(a, b);
  }

  debugFirst1024(): void {
    if (!this.got1024) {
      this.got1024 = true;
      this.score += this.tuning.first1024;
      this.startCelebration(1024);
      this.emit({ type: 'first1024', x: TANK.width / 2, y: TANK.height - 100, score: this.tuning.first1024 });
    }
  }

  private buildStarterStack(): void {
    // 1024 经典浮力开局：顶部自然聚拢 10 颗球，留出宽阔水箱空间，首两发即可撞并连锁
    const row0 = [4, 2, 8, 4, 2, 8];
    const row1 = [2, 8, 4, 16, 4];
    const placeRow = (values: number[], y: number, gap: number) => {
      let totalW = 0;
      for (const v of values) totalW += RADIUS[v] * 2;
      totalW += gap * (values.length - 1);
      let x = (TANK.width - totalW) * 0.5;
      for (const v of values) {
        const r = RADIUS[v];
        x += r;
        const ball = this.createBall(v, x, Math.min(TANK.topY - r, y), 0, 0);
        if (ball) {
          ball.bornAt = 0;
          this.balls.push(ball);
          if (v > this.maxBall) this.maxBall = v;
        }
        x += r + gap;
      }
    };
    placeRow(row0, TANK.topY - 22, 16);
    placeRow(row1, TANK.topY - 82, 22);
  }

  // ---------------------------------------------------------------- 发球池（按场内最高球智能递进）

  private drawSpawn(): number {
    if (this.spawnCount < 2) {
      const v = this.spawnCount === 0 ? 2 : 4;
      this.spawnCount++;
      this.recentSpawns.push(v);
      return v;
    }

    // 随场内最高数字平稳递进发球池（避免炮口直接白送 64，保留合成空间张力）
    const vals = [2, 4, 8, 16, 32, 64];
    let weights: number[];
    if (this.maxBall >= 512) weights = [18, 26, 26, 20, 10, 0];
    else if (this.maxBall >= 256) weights = [22, 28, 26, 18, 6, 0];
    else if (this.maxBall >= 128) weights = [26, 30, 26, 14, 4, 0];
    else if (this.maxBall >= 32) weights = [32, 32, 24, 12, 0, 0];
    else weights = [40, 36, 24, 0, 0, 0];

    const pick = (): number => {
      const total = weights.reduce((a, b) => a + b, 0);
      let r = this.rng() * total;
      for (let i = 0; i < vals.length; i++) {
        r -= weights[i];
        if (r <= 0) return vals[i];
      }
      return vals[0];
    };

    let v = pick();
    if (this.recentSpawns.length >= 2 && this.recentSpawns[0] === v && this.recentSpawns[1] === v) {
      v = pick();
    }
    this.recentSpawns.push(v);
    if (this.recentSpawns.length > 2) this.recentSpawns.shift();
    this.spawnCount++;
    return v;
  }

  private createBall(value: number, x: number, y: number, vx = 0, vy = 0): Ball | null {
    const r = RADIUS[value];
    if (!r) return null;
    return {
      id: this.nextId++,
      value,
      r: r,
      x: clamp(x, r + 1, TANK.width - r - 1),
      y: clamp(y, r + 1, TANK.topY - r),
      vx,
      vy,
      state: 'stack',
      anchored: false,
      age: 0,
      wobblePhase: this.rng() * Math.PI * 2,
      fallVx: 0,
      fallVy: 0,
      bornAt: this.worldTime,
      launchedAt: 0,
      mergeLockUntil: 0,
    };
  }

  private emit(ev: WorldEvent): void {
    this.listener?.(ev);
  }
}
