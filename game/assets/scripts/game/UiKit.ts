/** Cocos UI 小工具：节点/文本/九宫格/按钮/图形，全部运行时创建，不依赖 prefab */
import {
  BlockInputEvents,
  Button,
  Color,
  Graphics,
  Label,
  Layers,
  Node,
  Sprite,
  SpriteFrame,
  UIOpacity,
  UITransform,
  Vec3,
} from 'cc';

export interface LabelOpts {
  fontSize?: number;
  lineHeight?: number;
  color?: Color;
  bold?: boolean;
  outline?: Color;
  outlineWidth?: number;
  align?: number;
  width?: number;
  height?: number;
  anchorX?: number;
  anchorY?: number;
  shadow?: boolean;
  overflow?: number;
}

export interface ButtonOpts {
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fontSize?: number;
  frame?: SpriteFrame;
  textColor?: Color;
  onClick: () => void;
  sliced?: boolean;
  bold?: boolean;
}

export function hex(h: string, a = 255): Color {
  const s = h.replace('#', '');
  return new Color(parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), a);
}

export function makeNode(
  name: string,
  parent: Node | null,
  x = 0,
  y = 0,
  w = 0,
  h = 0,
  anchorX = 0.5,
  anchorY = 0.5,
): Node {
  const n = new Node(name);
  n.layer = Layers.Enum.UI_2D;
  if (parent) n.parent = parent;
  n.setPosition(x, y, 0);
  const ui = n.addComponent(UITransform);
  if (w > 0 || h > 0) ui.setContentSize(w, h);
  ui.setAnchorPoint(anchorX, anchorY);
  return n;
}

export function addSprite(
  parent: Node,
  frame: SpriteFrame,
  x: number,
  y: number,
  w: number,
  h: number,
  sliced = false,
  anchorX = 0.5,
  anchorY = 0.5,
): Sprite {
  const n = makeNode('sprite', parent, x, y, w, h, anchorX, anchorY);
  const sp = n.addComponent(Sprite);
  // 必须先设 sizeMode 再赋 frame：Cocos 在 sizeMode=TRIMMED 时会用贴图原始尺寸覆盖节点尺寸
  sp.sizeMode = Sprite.SizeMode.CUSTOM;
  sp.type = sliced ? Sprite.Type.SLICED : Sprite.Type.SIMPLE;
  sp.spriteFrame = frame;
  sp.color = new Color(255, 255, 255, 255);
  n.getComponent(UITransform)!.setContentSize(w, h);
  return sp;
}

export function addLabel(parent: Node, text: string, x: number, y: number, opts: LabelOpts = {}): Label {
  const fontSize = opts.fontSize ?? 28;
  const w = opts.width ?? 600;
  const h = opts.height ?? Math.ceil(fontSize * 1.4);
  const n = makeNode('label', parent, x, y, w, h, opts.anchorX ?? 0.5, opts.anchorY ?? 0.5);
  const label = n.addComponent(Label);
  label.string = text;
  label.fontSize = fontSize;
  label.lineHeight = opts.lineHeight ?? Math.ceil(fontSize * 1.16);
  label.color = opts.color ?? hex('#FFFFFF');
  label.horizontalAlign = opts.align ?? Label.HorizontalAlign.CENTER;
  label.verticalAlign = Label.VerticalAlign.CENTER;
  label.overflow = opts.overflow ?? (opts.width ? Label.Overflow.SHRINK : Label.Overflow.NONE);
  label.isBold = opts.bold ?? false;
  if (opts.outline) {
    label.enableOutline = true;
    label.outlineColor = opts.outline;
    label.outlineWidth = opts.outlineWidth ?? 2;
  }
  if (opts.shadow) {
    label.enableShadow = true;
    label.shadowColor = new Color(0, 30, 50, 150);
    label.shadowOffset.set(2, -3);
    label.shadowBlur = 4;
  }
  return label;
}

export function addButton(parent: Node, opts: ButtonOpts): Node {
  const frame = opts.frame;
  if (!frame) throw new Error('按钮缺少 SpriteFrame');
  const n = makeNode('button', parent, opts.x, opts.y, opts.width, opts.height, 0.5, 0.5);
  const sp = n.addComponent(Sprite);
  sp.sizeMode = Sprite.SizeMode.CUSTOM;
  sp.type = opts.sliced === false ? Sprite.Type.SIMPLE : Sprite.Type.SLICED;
  sp.spriteFrame = frame;
  n.getComponent(UITransform)!.setContentSize(opts.width, opts.height);
  const btn = n.addComponent(Button);
  btn.transition = Button.Transition.SCALE;
  btn.zoomScale = 0.94;
  btn.duration = 0.08;
  n.addComponent(BlockInputEvents);
  if (opts.text) {
    addLabel(n, opts.text, 0, 1, {
      fontSize: opts.fontSize ?? 34,
      color: opts.textColor ?? hex('#FFFFFF'),
      bold: opts.bold ?? true,
      outline: hex('#063A50', 190),
      outlineWidth: 2,
      width: opts.width - 12,
      height: opts.height - 8,
    });
  }
  n.on(Button.EventType.CLICK, () => {
    opts.onClick();
  });
  return n;
}

export function addGraphics(parent: Node, x: number, y: number, w: number, h: number): Graphics {
  const n = makeNode('graphics', parent, x, y, w, h, 0, 0);
  const g = n.addComponent(Graphics);
  g.lineCap = Graphics.LineCap.ROUND;
  g.lineJoin = Graphics.LineJoin.ROUND;
  return g;
}

export function fillRect(g: Graphics, x: number, y: number, w: number, h: number, color: Color): void {
  g.fillColor = color;
  g.rect(x, y, w, h);
  g.fill();
}

export function roundRect(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill?: Color,
  stroke?: Color,
  lineWidth = 2,
): void {
  if (fill) {
    g.fillColor = fill;
    g.roundRect(x, y, w, h, r);
    g.fill();
  }
  if (stroke) {
    g.strokeColor = stroke;
    g.lineWidth = lineWidth;
    g.roundRect(x, y, w, h, r);
    g.stroke();
  }
}

export function circle(g: Graphics, x: number, y: number, r: number, fill?: Color, stroke?: Color, lineWidth = 2): void {
  if (fill) {
    g.fillColor = fill;
    g.circle(x, y, r);
    g.fill();
  }
  if (stroke) {
    g.strokeColor = stroke;
    g.lineWidth = lineWidth;
    g.circle(x, y, r);
    g.stroke();
  }
}

export function setOpacity(node: Node, value: number): UIOpacity {
  let op = node.getComponent(UIOpacity);
  if (!op) op = node.addComponent(UIOpacity);
  op.opacity = Math.max(0, Math.min(255, value));
  return op;
}

export function opacityOf(node: Node): UIOpacity {
  let op = node.getComponent(UIOpacity);
  if (!op) op = node.addComponent(UIOpacity);
  return op;
}

export function blockInput(node: Node): void {
  if (!node.getComponent(BlockInputEvents)) node.addComponent(BlockInputEvents);
}

export function formatNumber(n: number): string {
  const s = Math.max(0, Math.round(n)).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

export function toScreen(parent: Node, x: number, y: number): Vec3 {
  return new Vec3(x, y, 0);
}
/** 取按钮内的文本（addButton 的文本是唯一 Label 子节点） */
export function buttonLabel(button: Node): Label | null {
  return button.getComponentInChildren(Label);
}

export function setButtonLabel(button: Node, text: string): void {
  const label = buttonLabel(button);
  if (label) label.string = text;
}

/** 启用/禁用按钮：禁用时半透明且不响应点击 */
export function setButtonEnabled(button: Node, enabled: boolean): void {
  const btn = button.getComponent(Button);
  if (btn) btn.interactable = enabled;
  const op = opacityOf(button);
  op.opacity = enabled ? 255 : 110;
}

/** 全屏暗色遮罩，返回节点（已带 BlockInputEvents） */
export function addDim(parent: Node, w: number, h: number, alpha = 190, x = 0, y = 0): Node {
  const node = makeNode('dim', parent, x, y, w, h, 0, 0);
  const g = addGraphics(node, 0, 0, w, h);
  g.fillColor = new Color(2, 18, 28, alpha);
  g.rect(0, 0, w, h);
  g.fill();
  blockInput(node);
  return node;
}

/** 九宫格面板；frame 需在 AssetHub 里配置过 inset */
export function addPanel(
  parent: Node,
  frame: SpriteFrame,
  x: number,
  y: number,
  w: number,
  h: number,
  anchorX = 0.5,
  anchorY = 0.5,
): Sprite {
  return addSprite(parent, frame, x, y, w, h, true, anchorX, anchorY);
}

/** 高精度矢量深海玻璃胶囊牌（替代粗边框九宫格拉伸，用于分数/最高分栏） */
export function addScoreCapsule(
  parent: Node,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { accent?: 'cyan' | 'gold'; icon?: 'crown' | 'none' } = {},
): Node {
  const n = makeNode('ScoreCapsule', parent, x, y, w, h);
  const g = n.addComponent(Graphics);
  g.lineCap = Graphics.LineCap.ROUND;
  g.lineJoin = Graphics.LineJoin.ROUND;
  const hw = w * 0.5;
  const hh = h * 0.5;
  const r = hh * 0.88;
  const accentCol = opts.accent === 'gold' ? hex('#F7D36A', 210) : hex('#86ECFF', 180);

  // 底部柔和投影
  roundRect(g, -hw, -hh - 3, w, h, r, hex('#021824', 105));
  // 外层深海玻壳与微弱浅青外光
  roundRect(g, -hw, -hh, w, h, r, hex('#06364D', 238), hex('#38E3FF', 110), 1.5);
  // 内层透亮玻璃底 + 极细高光描边
  roundRect(g, -hw + 3, -hh + 3, w - 6, h - 6, Math.max(4, r - 3), hex('#094B69', 225), accentCol, 2);
  // 顶部弧面玻璃反光带
  const shineH = h * 0.36;
  roundRect(g, -hw + 12, 2, w - 24, shineH, shineH * 0.5, hex('#B0F8FF', 34));

  if (opts.icon === 'crown') {
    const cx = -hw + 34;
    const cy = -1;
    g.fillColor = hex('#FFD34E');
    g.moveTo(cx - 12, cy - 6);
    g.lineTo(cx - 14, cy + 7);
    g.lineTo(cx - 6, cy + 1);
    g.lineTo(cx, cy + 10);
    g.lineTo(cx + 6, cy + 1);
    g.lineTo(cx + 14, cy + 7);
    g.lineTo(cx + 12, cy - 6);
    g.close();
    g.fill();
    g.strokeColor = hex('#8A5500', 220);
    g.lineWidth = 1.6;
    g.stroke();
    roundRect(g, cx - 12, cy - 10, 24, 3.5, 1.5, hex('#FFF1A8'));
  }
  return n;
}
