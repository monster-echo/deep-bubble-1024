/**
 * 场景入口：加载资源 -> 构建 GameApp。
 * 场景文件只保留 Canvas/Camera/GameRoot，其余 UI 全部运行时创建。
 */
import { _decorator, Canvas, Component, Graphics, Label, Node, ResolutionPolicy, UITransform, view } from 'cc';
import { AssetHub } from './game/AssetHub';
import { GameApp } from './game/GameApp';
import { addLabel, hex, makeNode } from './game/UiKit';

const { ccclass } = _decorator;

@ccclass('Bootstrap')
export class Bootstrap extends Component {
  private app: GameApp | null = null;
  private loading: Node | null = null;
  private bar: Graphics | null = null;
  private pct: Label | null = null;
  private label: Label | null = null;
  private destroyed = false;

  onLoad(): void {
    this.applyResponsiveResolution();
    view.on('canvas-resize', this.syncCameraToVisible, this);
    this.buildLoading();
    void this.boot();
  }

  start(): void {
    this.syncCameraToVisible();
  }

  private applyResponsiveResolution(): void {
    // 响应式竖屏适配：窄屏按 750 宽拉伸高，iPad 等宽竖屏（比例 > 9:16）切为定高居中避免纵向压扁
    const frame = view.getFrameSize();
    const ratio = frame.height > 0 ? frame.width / frame.height : 750 / 1334;
    const policy = ratio > 750 / 1334 + 0.01 ? ResolutionPolicy.FIXED_HEIGHT : ResolutionPolicy.FIXED_WIDTH;
    view.setDesignResolutionSize(750, 1334, policy);
    this.syncCameraToVisible();
  }

  private syncCameraToVisible(): void {
    const vis = view.getVisibleSize();
    const canvas = this.node.parent?.getComponent(Canvas);
    if (canvas) {
      const ut = canvas.node.getComponent(UITransform);
      if (ut) ut.setContentSize(vis.width, vis.height);
      if (canvas.cameraComponent) {
        canvas.cameraComponent.orthoHeight = vis.height / 2;
      }
    }
  }

  private async boot(): Promise<void> {
    const assets = new AssetHub();
    try {
      await assets.loadAll((p, label) => this.setProgress(p, label));
    } catch (e) {
      console.error('[Liquid1024] 资源加载失败', e);
      this.showError(e);
      return;
    }
    if (this.destroyed) return;
    try {
      this.app = new GameApp(this.node, assets);
    } catch (e) {
      console.error('[Liquid1024] 初始化失败', e);
      this.showError(e);
      return;
    }
    if (this.loading) {
      this.loading.destroy();
      this.loading = null;
    }
  }

  update(dt: number): void {
    this.app?.update(dt);
  }

  onDestroy(): void {
    view.off('canvas-resize', this.syncCameraToVisible, this);
    this.destroyed = true;
    this.app = null;
  }

  private buildLoading(): void {
    const size = view.getVisibleSize();
    const w = Math.max(750, Math.round(size.width || 750));
    const h = Math.max(900, Math.round(size.height || 1334));
    const cx = w / 2;
    const n = makeNode('Loading', this.node, -cx, -h / 2, w, h, 0, 0);
    this.loading = n;
    const g = n.addComponent(Graphics);
    g.fillColor = hex('#032331');
    g.rect(0, 0, w, h);
    g.fill();
    // 水色光带
    g.fillColor = hex('#0B4A60', 160);
    g.circle(cx, h / 2, Math.max(300, w * 0.42));
    g.fill();
    addLabel(n, '深海啵啵 1024', cx, h / 2 + 150, {
      fontSize: 72, width: 640, bold: true, color: hex('#FFE08A'), outline: hex('#053A50', 230), outlineWidth: 5,
    });
    addLabel(n, 'D E E P   B U B B L E   1 0 2 4', cx, h / 2 + 88, {
      fontSize: 19, width: 600, color: hex('#BFF8FF'),
    });
    const barBase = makeNode('loadBar', n, cx, h / 2 - 10, 500, 14);
    const bg = barBase.addComponent(Graphics);
    bg.fillColor = hex('#062A3B', 230);
    bg.roundRect(-240, -7, 480, 14, 7);
    bg.fill();
    bg.strokeColor = hex('#63E6F2', 140);
    bg.lineWidth = 2;
    bg.roundRect(-240, -7, 480, 14, 7);
    bg.stroke();
    const fill = makeNode('loadFill', barBase, -240, 0, 480, 12, 0, 0.5);
    this.bar = fill.addComponent(Graphics);
    this.setProgress(0, '开始加载');
    this.pct = addLabel(n, '0%', 375, h / 2 - 46, { fontSize: 20, color: hex('#BFF8FF') });
    this.label = addLabel(n, '开始加载', 375, h / 2 - 80, { fontSize: 17, color: hex('#9FE9F2', 190) });
    addLabel(n, 'v0.6 · M2', 375, 40, { fontSize: 16, color: hex('#9FE9F2', 150) });
  }

  private setProgress(p: number, text: string): void {
    const value = Math.max(0, Math.min(1, p));
    if (this.bar) {
      this.bar.clear();
      this.bar.fillColor = hex('#6FE3B0');
      this.bar.roundRect(0, -6, Math.max(6, 480 * value), 12, 6);
      this.bar.fill();
      this.bar.fillColor = hex('#C8FFF0', 140);
      this.bar.roundRect(2, 0, Math.max(4, 480 * value - 4), 4, 2);
      this.bar.fill();
    }
    if (this.pct) this.pct.string = `${Math.round(value * 100)}%`;
    if (this.label) this.label.string = text;
  }

  private showError(e: unknown): void {
    if (!this.loading) return;
    const msg = e instanceof Error ? e.message : String(e);
    addLabel(this.loading, '资源加载失败', 375, 300, {
      fontSize: 34, bold: true, color: hex('#FF8A98'), width: 700,
    });
    addLabel(this.loading, msg.slice(0, 120), 375, 240, {
      fontSize: 18, color: hex('#FFFFFF'), width: 660,
    });
    addLabel(this.loading, '请检查 resources 资源与网络后重开', 375, 190, {
      fontSize: 18, color: hex('#9FE9F2'), width: 660,
    });
    if (this.label) this.label.string = '加载失败';
  }
}
