/**
 * 广告抽象层（M2 只接占位实现，不接真 SDK）
 *
 * GAME.md §6 的 7 个广告位全部在这里预留：
 *   1 复活        RewardPlacement 'revive'
 *   2 道具补给    'itemSupply'
 *   3 双倍结算    'doubleScore'
 *   4 辅助线延长  'aimExtend'
 *   5 力度条减速  'slowPower'
 *   6 插屏        InterstitialAdProvider
 *   7 Banner      BannerAdProvider
 *
 * 接微信时实现 WechatRewardedAd（wx.createRewardedVideoAd），
 * 接 AdMob 时实现 AdmobRewardedAd；游戏逻辑只依赖 AdService，不改业务层。
 */

export type RewardPlacement = 'revive' | 'itemSupply' | 'doubleScore' | 'aimExtend' | 'slowPower';
export type AdPlacement = RewardPlacement | 'interstitial' | 'banner';

export interface AdResult {
  ok: boolean;
  /** 用户中途关闭 / 无填充 / 网络错误 */
  reason?: 'closed' | 'no-fill' | 'error' | 'unsupported';
}

export interface RewardedAdProvider {
  isSupported(): boolean;
  preload(placement: RewardPlacement): Promise<void>;
  show(placement: RewardPlacement): Promise<AdResult>;
}

export interface InterstitialAdProvider {
  isSupported(): boolean;
  show(): Promise<AdResult>;
}

export interface BannerAdProvider {
  isSupported(): boolean;
  show(): Promise<void>;
  hide(): void;
}

/** M2 占位：直接发放奖励（无真实广告可播）；M4 接微信/AdMob 时换成真实 Provider */
export class MockRewardedAd implements RewardedAdProvider {
  isSupported(): boolean {
    return true;
  }
  async preload(): Promise<void> {
    /* no-op */
  }
  async show(placement: RewardPlacement): Promise<AdResult> {
    console.log(`[AdService] mock rewarded: ${placement}`);
    return { ok: true };
  }
}

export class MockInterstitialAd implements InterstitialAdProvider {
  isSupported(): boolean {
    return true;
  }
  async show(): Promise<AdResult> {
    console.log('[AdService] mock interstitial');
    await new Promise((r) => setTimeout(r, 600));
    return { ok: true };
  }
}

export class MockBannerAd implements BannerAdProvider {
  isSupported(): boolean {
    return true;
  }
  async show(): Promise<void> {
    console.log('[AdService] mock banner show');
  }
  hide(): void {
    console.log('[AdService] mock banner hide');
  }
}

export class AdService {
  rewarded: RewardedAdProvider;
  interstitial: InterstitialAdProvider;
  banner: BannerAdProvider;
  private busy = false;

  constructor(
    rewarded: RewardedAdProvider = new MockRewardedAd(),
    interstitial: InterstitialAdProvider = new MockInterstitialAd(),
    banner: BannerAdProvider = new MockBannerAd(),
  ) {
    this.rewarded = rewarded;
    this.interstitial = interstitial;
    this.banner = banner;
  }

  async showRewarded(placement: RewardPlacement): Promise<AdResult> {
    if (this.busy) return { ok: false, reason: 'error' };
    if (!this.rewarded.isSupported()) return { ok: false, reason: 'unsupported' };
    this.busy = true;
    try {
      return await this.rewarded.show(placement);
    } catch (e) {
      console.warn('[AdService] rewarded failed', e);
      return { ok: false, reason: 'error' };
    } finally {
      this.busy = false;
    }
  }

  async showInterstitial(): Promise<AdResult> {
    if (this.busy) return { ok: false, reason: 'error' };
    if (!this.interstitial.isSupported()) return { ok: false, reason: 'unsupported' };
    this.busy = true;
    try {
      return await this.interstitial.show();
    } catch (e) {
      return { ok: false, reason: 'error' };
    } finally {
      this.busy = false;
    }
  }

  async showBanner(): Promise<void> {
    try {
      await this.banner.show();
    } catch {
      /* ignore */
    }
  }

  hideBanner(): void {
    this.banner.hide();
  }
}
