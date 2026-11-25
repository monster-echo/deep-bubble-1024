/** 资源加载：图集按 rect 切 SpriteFrame，UI 九宫格与音频统一在这里就绪 */
import {
  AudioClip,
  ImageAsset,
  JsonAsset,
  Rect,
  Size,
  SpriteFrame,
  Texture2D,
  Vec2,
  resources,
} from 'cc';

export interface AtlasFrameMeta {
  rect: [number, number, number, number];
  atlas: string;
  sourceSize: [number, number];
  displayScale: number;
}

/** 单图集：数字 -> 帧（避免 small/big 两张图集打断合批） */
export type AtlasMeta = Record<string, AtlasFrameMeta>;

export interface BallArt {
  frame: SpriteFrame;
  displayScale: number;
}

export type TexName =
  | 'panel_glass'
  | 'button_glass'
  | 'button_gold'
  | 'preview_frame'
  | 'power_track'
  | 'power_fill'
  | 'power_knob'
  | 'danger_vignette'
  | 'gold_ring'
  | 'btn_drain'
  | 'btn_melt'
  | 'btn_magnet'
  | 'btn_pause'
  | 'wild_orb'
  | 'turret_base'
  | 'turret_barrel';

const TEX_PATHS: Record<TexName, string> = {
  panel_glass: 'textures/ui/panel_glass',
  button_glass: 'textures/ui/button_glass',
  button_gold: 'textures/ui/button_gold',
  preview_frame: 'textures/ui/preview_frame',
  power_track: 'textures/ui/power_track',
  power_fill: 'textures/ui/power_fill',
  power_knob: 'textures/ui/power_knob',
  danger_vignette: 'textures/ui/danger_vignette',
  gold_ring: 'textures/ui/gold_ring',
  btn_drain: 'textures/ui/btn_drain',
  btn_melt: 'textures/ui/btn_melt',
  btn_magnet: 'textures/ui/btn_magnet',
  btn_pause: 'textures/ui/btn_pause',
  wild_orb: 'textures/ui/wild_orb',
  turret_base: 'textures/ui/turret_base',
  turret_barrel: 'textures/ui/turret_barrel',
};

const TURRET_PATHS = {
  idle: 'textures/turret/turret_idle',
  charge: 'textures/turret/turret_charge',
  fire: 'textures/turret/turret_fire',
};

const AUDIO_PATHS = [
  'shoot',
  'merge',
  'merge_1',
  'merge_2',
  'merge_3',
  'merge_4',
  'merge_5',
  'merge_6',
  'squeeze',
  'bounce',
  'swap',
  'drop',
  'click',
  'win',
  'danger',
  'charge_max',
  'rainbow',
  'voice_great',
  'voice_amazing',
  'voice_unstoppable',
  'voice_legend',
] as const;
export type AudioName = (typeof AUDIO_PATHS)[number];

function loadAsset<T>(path: string, type: new (...args: any[]) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    (resources as any).load(path, type, (err: Error | null, asset: T) => {
      if (err || !asset) reject(err ?? new Error(`资源加载失败: ${path}`));
      else resolve(asset);
    });
  });
}

function imageToTexture(img: ImageAsset): Texture2D {
  const tex = new Texture2D();
  tex.image = img;
  tex.setFilters(Texture2D.Filter.LINEAR, Texture2D.Filter.LINEAR);
  tex.setMipFilter(Texture2D.Filter.NONE);
  return tex;
}

function fullFrame(tex: Texture2D): SpriteFrame {
  const f = new SpriteFrame();
  f.texture = tex;
  f.rect = new Rect(0, 0, tex.width, tex.height);
  f.originalSize = new Size(tex.width, tex.height);
  f.offset = new Vec2(0, 0);
  f.packable = false;
  return f;
}

export class AssetHub {
  balls: Map<number, BallArt> = new Map();
  ui: Partial<Record<TexName, SpriteFrame>> = {};
  turret: Partial<Record<'idle' | 'charge' | 'fire', SpriteFrame>> = {};
  bgNormal!: SpriteFrame;
  bgDanger!: SpriteFrame;
  audio: Partial<Record<AudioName, AudioClip>> = {};

  async loadAll(onProgress?: (p: number, label: string) => void): Promise<void> {
    const steps: { label: string; run: () => Promise<void> }[] = [];
    const add = (label: string, run: () => Promise<void>) => steps.push({ label, run });

    add('球体图集', async () => {
      const meta = (await loadAsset('textures/balls/atlas', JsonAsset)).json as AtlasMeta;
      const img = await loadAsset('textures/balls/balls', ImageAsset);
      const tex = imageToTexture(img);
      for (const value of Object.keys(meta)) {
        const m = meta[value];
        const frame = new SpriteFrame();
        frame.texture = tex;
        frame.rect = new Rect(m.rect[0], m.rect[1], m.rect[2], m.rect[3]);
        frame.originalSize = new Size(m.sourceSize[0], m.sourceSize[1]);
        frame.offset = new Vec2(0, 0);
        frame.packable = false;
        this.balls.set(Number(value), { frame, displayScale: m.displayScale });
      }
    });

    add('界面', async () => {
      const names = Object.keys(TEX_PATHS) as TexName[];
      const imgs = await Promise.all(names.map((n) => loadAsset(TEX_PATHS[n], ImageAsset)));
      // 九宫格 inset 必须小于最小使用高度，否则中心会被压塌（HUD 面板仅 84px 高）
      const insets: Partial<Record<TexName, [number, number, number, number]>> = {
        panel_glass: [30, 30, 30, 30],
        button_glass: [20, 20, 20, 20],
        button_gold: [20, 20, 20, 20],
        preview_frame: [20, 20, 20, 20],
        power_track: [22, 22, 6, 6],
      };
      names.forEach((name, i) => {
        const f = fullFrame(imageToTexture(imgs[i]));
        const inset = insets[name];
        if (inset) {
          f.insetLeft = inset[0];
          f.insetRight = inset[1];
          f.insetTop = inset[2];
          f.insetBottom = inset[3];
        }
        this.ui[name] = f;
      });
    });

    add('炮台', async () => {
      const keys = Object.keys(TURRET_PATHS) as (keyof typeof TURRET_PATHS)[];
      const imgs = await Promise.all(keys.map((k) => loadAsset(TURRET_PATHS[k], ImageAsset)));
      keys.forEach((k, i) => {
        this.turret[k] = fullFrame(imageToTexture(imgs[i]));
      });
    });

    add('背景', async () => {
      const [n, d] = await Promise.all([
        loadAsset('textures/bg/bg_normal', ImageAsset),
        loadAsset('textures/bg/bg_danger', ImageAsset),
      ]);
      this.bgNormal = fullFrame(imageToTexture(n));
      this.bgDanger = fullFrame(imageToTexture(d));
    });

    add('音效', async () => {
      const clips = await Promise.all(AUDIO_PATHS.map((n) => loadAsset(`audio/${n}`, AudioClip).catch(() => null)));
      AUDIO_PATHS.forEach((n, i) => {
        if (clips[i]) this.audio[n] = clips[i] as AudioClip;
      });
    });

    let done = 0;
    for (const s of steps) {
      onProgress?.(done / steps.length, s.label);
      await s.run();
      done++;
      onProgress?.(done / steps.length, s.label);
    }
  }

  ball(value: number): BallArt | undefined {
    return this.balls.get(value);
  }
}
