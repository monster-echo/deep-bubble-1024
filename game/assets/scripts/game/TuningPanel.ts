/**
 * 开发期调参面板（GAME.md §4.8）
 * - 6 项/页，覆盖全部 35 个数值参数；
 * - 真机可直接点按调，改动立即写入 BallWorld 并持久化；
 * - 附带压测/触发 1024/加分等调试动作；
 * - 发版前把 Storage.isDebugEnabled 默认改为 false 即可整体隐藏入口。
 */
import { Label, Node } from 'cc';
import { DEFAULT_TUNING, PARAM_DEFS, PHASES, SPAWN_WEIGHTS, cloneTuning } from '../core/Config';
import type { ParamDef, Tuning } from '../core/Config';
import type { AssetHub } from './AssetHub';
import { addButton, addGraphics, addLabel, blockInput, hex, makeNode, roundRect } from './UiKit';

const PER_PAGE = 6;

export interface TuningCallbacks {
  onChange: (t: Tuning) => void;
  onClose: () => void;
  onDebug: (kind: 'fill' | 'first1024' | 'score' | 'clear') => void;
  onToast: (msg: string) => void;
}

export class TuningPanel {
  readonly root: Node;
  private panel: Node;
  private tuning: Tuning = cloneTuning(DEFAULT_TUNING);
  private page = 0;
  private rowNodes: Node[] = [];
  private nameLabels: Label[] = [];
  private groupLabels: Label[] = [];
  private valueLabels: Label[] = [];
  private pageLabel!: Label;
  private fpsLabel!: Label;
  private tableLabel!: Label;
  private tableCopyBtn!: Node;
  private numericPages = Math.ceil(PARAM_DEFS.length / PER_PAGE);

  constructor(
    parent: Node,
    private assets: AssetHub,
    private designH: number,
    private cb: TuningCallbacks,
    screenWidth = 750,
  ) {
    this.root = makeNode('TuningPanel', parent, 0, 0, 750, designH, 0, 0);
    blockInput(this.root);
    const dimX = 375 - screenWidth / 2;
    const dim = addGraphics(this.root, dimX, 0, screenWidth, designH);
    dim.fillColor = hex('#021E2C', 225);
    dim.rect(0, 0, screenWidth, designH);
    dim.fill();

    const cy = Math.min(designH / 2, 680);
    this.panel = makeNode('panel', this.root, 375, cy, 710, 1120);
    const bg = addGraphics(this.panel, -355, -560, 710, 1120);
    bg.fillColor = hex('#063247', 248);
    bg.roundRect(0, 0, 710, 1120, 34);
    bg.fill();
    bg.strokeColor = hex('#63E6F2', 200);
    bg.lineWidth = 3;
    bg.roundRect(2, 2, 706, 1116, 34);
    bg.stroke();
    bg.strokeColor = hex('#FFD24A', 90);
    bg.lineWidth = 1;
    bg.roundRect(12, 12, 686, 1096, 28);
    bg.stroke();

    addLabel(this.panel, '调参面板 · M2', 0, 505, {
      fontSize: 34, bold: true, color: hex('#FFE9A8'), outline: hex('#063A50'), outlineWidth: 2,
    });
    addLabel(this.panel, '改动即时生效 · 持久化到本机', 0, 468, {
      fontSize: 19, color: hex('#9FE9F2'),
    });
    this.fpsLabel = addLabel(this.panel, 'FPS --', -330, 515, {
      fontSize: 18, color: hex('#8FF0D8'), width: 120, align: Label.HorizontalAlign.LEFT, anchorX: 0,
    });

    // 表驱动参数只读页（发球池 / 无尽阶段 / 首达与深度），可复制 JSON
    this.tableLabel = addLabel(this.panel, '', 0, 120, {
      fontSize: 16, color: hex('#DFFFFF'), width: 640, height: 500, lineHeight: 25,
      align: Label.HorizontalAlign.LEFT, anchorX: 0.5,
    });
    this.tableLabel.node.active = false;
    this.tableCopyBtn = addButton(this.panel, {
      x: 0, y: -280, width: 230, height: 54, text: '复制表格 JSON', fontSize: 19,
      frame: this.assets.ui.button_glass!, onClick: () => this.copyTable(),
    });
    this.tableCopyBtn.active = false;

    for (let i = 0; i < PER_PAGE; i++) {
      const y = 380 - i * 104;
      const row = makeNode('row', this.panel, 0, y, 640, 88);
      const g = addGraphics(row, -320, -40, 640, 80);
      roundRect(g, 0, 0, 640, 80, 16, hex('#0B4A60', 220), hex('#47C7DA', 90), 1.5);
      this.groupLabels.push(addLabel(row, '', -260, 24, {
        fontSize: 16, color: hex('#7FD8E4'), width: 100, align: Label.HorizontalAlign.LEFT, anchorX: 0,
      }));
      this.nameLabels.push(addLabel(row, '', -260, -4, {
        fontSize: 24, bold: true, color: hex('#FFFFFF'), width: 310, align: Label.HorizontalAlign.LEFT, anchorX: 0,
      }));
      this.valueLabels.push(addLabel(row, '', 150, -2, {
        fontSize: 28, bold: true, color: hex('#FFD24A'), width: 150,
      }));
      addButton(row, {
        x: 238, y: 0, width: 52, height: 52, text: '−', fontSize: 32,
        frame: this.assets.ui.button_glass!, onClick: () => this.adjust(i, -1),
      });
      addButton(row, {
        x: 292, y: 0, width: 52, height: 52, text: '+', fontSize: 32,
        frame: this.assets.ui.button_glass!, onClick: () => this.adjust(i, 1),
      });
      this.rowNodes.push(row);
    }

    addButton(this.panel, {
      x: -240, y: -360, width: 96, height: 56, text: '上一页', fontSize: 22,
      frame: this.assets.ui.button_glass!, onClick: () => this.turnPage(-1),
    });
    this.pageLabel = addLabel(this.panel, '1 / 6', 0, -360, {
      fontSize: 24, color: hex('#BFF8FF'), bold: true,
    });
    addButton(this.panel, {
      x: 240, y: -360, width: 96, height: 56, text: '下一页', fontSize: 22,
      frame: this.assets.ui.button_glass!, onClick: () => this.turnPage(1),
    });

    const actions: { text: string; x: number; w: number; fn: () => void }[] = [
      { text: '重置', x: -250, w: 100, fn: () => this.reset() },
      { text: '压测+20球', x: -120, w: 150, fn: () => this.cb.onDebug('fill') },
      { text: '触发1024', x: 30, w: 140, fn: () => this.cb.onDebug('first1024') },
      { text: '加1万分', x: 165, w: 120, fn: () => this.cb.onDebug('score') },
      { text: '清场', x: 275, w: 90, fn: () => this.cb.onDebug('clear') },
    ];
    for (const a of actions) {
      addButton(this.panel, {
        x: a.x, y: -430, width: a.w, height: 54, text: a.text, fontSize: 20,
        frame: this.assets.ui.button_glass!, onClick: a.fn,
      });
    }
    addButton(this.panel, {
      x: -250, y: -500, width: 180, height: 54, text: '导出参数 JSON', fontSize: 20,
      frame: this.assets.ui.button_glass!, onClick: () => this.exportTuning(),
    });
    addButton(this.panel, {
      x: 210, y: -500, width: 150, height: 54, text: '关闭', fontSize: 24,
      frame: this.assets.ui.button_gold!, onClick: () => this.cb.onClose(),
    });
    this.root.active = false;
  }

  setFps(fps: number): void {
    this.fpsLabel.string = `FPS ${fps.toFixed(0)}`;
  }

  open(t: Tuning): void {
    this.tuning = t;
    this.page = 0;
    this.root.active = true;
    this.refresh();
  }

  close(): void {
    this.root.active = false;
  }

  private turnPage(d: number): void {
    const pages = this.numericPages + 1;
    this.page = (this.page + d + pages) % pages;
    this.refresh();
  }

  private adjust(row: number, dir: number): void {
    if (this.page >= this.numericPages) return;
    const idx = this.page * PER_PAGE + row;
    const def = PARAM_DEFS[idx];
    if (!def) return;
    let v = (this.tuning[def.key] as number) + def.step * dir;
    v = Math.max(def.min, Math.min(def.max, v));
    if (Number.isInteger(def.step) || def.step >= 1) v = Math.round(v);
    else v = Math.round(v * 1000) / 1000;
    (this.tuning as unknown as Record<string, number>)[def.key] = v;
    this.refresh();
    this.cb.onChange(this.tuning);
  }

  private reset(): void {
    this.tuning = cloneTuning(DEFAULT_TUNING);
    this.refresh();
    this.cb.onChange(this.tuning);
    this.cb.onToast('已恢复 §4.8 默认值');
  }

  private exportTuning(): void {
    this.copyText(JSON.stringify(this.tuning, null, 2), '参数 JSON 已复制');
  }

  private copyTable(): void {
    const table = {
      spawnWeights: SPAWN_WEIGHTS,
      phases: PHASES.map((p) => ({
        key: p.key, name: p.name, start: p.start, pool: p.pool,
        sweep: Number(p.sweepAt(p.start).toFixed(2)),
        line: p.lineAt(p.start),
      })),
      first1024: this.tuning.first1024,
      first2048: this.tuning.first2048,
      depthStep: this.tuning.depthStep,
      depthCap: this.tuning.depthCap,
    };
    this.copyText(JSON.stringify(table, null, 2), '表驱动 JSON 已复制');
  }

  private copyText(text: string, okMsg: string): void {
    const g: any = typeof globalThis !== 'undefined' ? (globalThis as any) : {};
    try {
      if (g.wx && typeof g.wx.setClipboardData === 'function') {
        g.wx.setClipboardData({ data: text });
      } else if (typeof navigator !== 'undefined' && (navigator as any).clipboard) {
        (navigator as any).clipboard.writeText(text);
      }
      this.cb.onToast(okMsg);
    } catch {
      this.cb.onToast('导出失败，请重试');
    }
  }

  private tableText(): string {
    const head = '发球池：2 / 4 / 8 / 16 / 32 / 64';
    const padL = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
    const padR = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
    const pools = SPAWN_WEIGHTS.map((row, i) => `P${i}  ${row.map((n) => padL(String(n), 3)).join(' ')}`).join('\n');
    const phases = PHASES.map((p) => {
      const t = `${Math.floor(p.start / 60)}:${padL(String(p.start % 60), 2).replace(/ /g, '0')}`;
      return `${padL(t, 4)}  ${padR(p.name, 4)}  P${p.pool}  ${p.sweepAt(p.start).toFixed(2)}s  y${p.lineAt(p.start)}`;
    }).join('\n');
    return [
      '【表驱动参数 · 只读】',
      head,
      pools,
      '',
      '【无尽阶段】 时间  名称  池  扫速  线',
      phases,
      '',
      `【首达】1024 +${this.tuning.first1024}   2048 +${this.tuning.first2048}`,
      `【深度】每层 +${(this.tuning.depthStep * 100).toFixed(0)}%  封顶 ×${this.tuning.depthCap.toFixed(1)}`,
      '',
      '修改发球池/阶段表请编辑核心数值表，',
      '或复制 JSON 后按 §4.8 表格导入。',
    ].join('\n');
  }

  private refresh(): void {
    const pages = this.numericPages + 1;
    const tableMode = this.page >= this.numericPages;
    this.pageLabel.string = tableMode ? `表格 ${pages} / ${pages}` : `${this.page + 1} / ${pages}`;
    this.tableLabel.node.active = tableMode;
    this.tableCopyBtn.active = tableMode;
    if (tableMode) this.tableLabel.string = this.tableText();
    for (let i = 0; i < PER_PAGE; i++) {
      const idx = this.page * PER_PAGE + i;
      const def = PARAM_DEFS[idx];
      const row = this.rowNodes[i];
      if (tableMode || !def) {
        row.active = false;
        continue;
      }
      row.active = true;
      this.nameLabels[i].string = def.label;
      this.groupLabels[i].string = `${def.group}${def.hint ? ' · ' + def.hint : ''}`;
      const v = this.tuning[def.key] as number;
      this.valueLabels[i].string = def.digits !== undefined ? v.toFixed(def.digits) : String(Math.round(v));
    }
  }
}

export type { ParamDef };