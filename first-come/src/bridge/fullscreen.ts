// One full-screen ad slot (the interstitial, or the rewarded video): keeps exactly one ad
// loaded, shows it, and reports how the showing ended.
//
// What the plugin does on iOS, read from @capacitor-community/admob 8.3.0
// (ios/Sources/AdMobPlugin/Interstitial/AdInterstitialExecutor.swift and
// Rewarded/AdRewardExecutor.swift). The state machine below is built on these facts:
//
//  prepareInterstitial / prepareRewardVideoAd
//    - loaded: emits the Loaded event, then resolves { adUnitId }
//    - failed: emits FailedToLoad, then rejects
//  showInterstitial
//    - resolves as soon as present() has been CALLED, long before the ad is closed
//    - rejects when nothing is prepared, or while another ad of that kind is up
//    - neither resolves nor rejects when the plugin cannot find a root view controller
//  showRewardVideoAd
//    - resolves { type, amount } from the SDK's userDidEarnReward handler, so ONLY when the
//      reward is earned. Closing the video early leaves this promise pending for ever.
//    - rejects / stays silent in the same cases as showInterstitial
//  events while showing
//    - Showed        (adWillPresentFullScreenContent)
//    - FailedToShow  (didFailToPresentFullScreenContentWithError)
//    - Rewarded      (rewarded only, same moment as the resolve above)
//    - Dismissed     (adDidDismissFullScreenContent)
//  after Dismissed or FailedToShow the plugin has thrown the ad object away: a new one
//  must be prepared before the next show.
//  prepared ads are filed under their AD UNIT ID (preparedAds[adUnitID]), and so is the
//  note of which one is on screen. Dismissed / FailedToShow delete preparedAds[that id],
//  whatever is filed there by then. An ad prepared for the same unit while the previous one
//  is still on screen replaces the entry and is the one that gets deleted.
//  all of this lives in the plugin instance, which outlives the web page: an ad the page
//  put up is still up, and still closes with a Dismissed event, after the page was reloaded.

import { attempt, backoffDelay, type Clock, type Logger } from './util.ts';

export type FullscreenKind = 'interstitial' | 'rewarded';

export type FullscreenEvent = 'loaded' | 'showed' | 'failedToShow' | 'dismissed' | 'rewarded';

export interface FullscreenDriver {
  /** Ask the plugin to load one ad: resolves when it is loaded, rejects when it is not. */
  load(): Promise<unknown>;
  /** Ask the plugin to present the loaded ad. */
  show(): Promise<unknown>;
}

export interface FullscreenTuning {
  /** First retry delay after a failed load; doubles with every further failure. */
  retryBaseMs: number;
  /** Longest retry delay. */
  retryCapMs: number;
  /** A load that has not answered after this long counts as failed. */
  loadTimeoutMs: number;
  /** show(): how long to wait for the ad to report that it is on screen. */
  presentTimeoutMs: number;
  /** show(): the longest an interstitial may stay on screen before the game is released anyway. */
  maxShowMs: number;
  /**
   * The same for a rewarded video. Much longer, because the release is final: a reward the
   * player earns after it can no longer be passed to the game.
   */
  maxRewardedShowMs: number;
  /** Tick of the timer that measures both of the above. */
  heartbeatMs: number;
  /** A tick this late means the app was suspended meanwhile; only this much of the gap counts. */
  maxBeatGapMs: number;
  /** After a rewarded ad closes without a reward, how long to wait for a late reward callback. */
  rewardGraceMs: number;
  /** Loaded ads expire; Google documents one hour. Older ones are replaced, not shown. */
  maxAdAgeMs: number;
}

export const DEFAULT_FULLSCREEN_TUNING: FullscreenTuning = {
  retryBaseMs: 4_000,
  retryCapMs: 5 * 60_000,
  loadTimeoutMs: 75_000,
  presentTimeoutMs: 10_000,
  maxShowMs: 3 * 60_000,
  maxRewardedShowMs: 10 * 60_000,
  heartbeatMs: 1_000,
  maxBeatGapMs: 3_000,
  rewardGraceMs: 400,
  maxAdAgeMs: 50 * 60_000,
};

export interface FullscreenHost {
  clock: Clock;
  log: Logger;
  tuning: FullscreenTuning;
  /** Consent is settled and the SDK is running: ads may be requested. */
  canLoad(): boolean;
  /** A full-screen ad (of either kind) is on screen right now. */
  busy(): boolean;
}

export interface FullscreenSlot {
  readonly kind: FullscreenKind;
  /** An ad is loaded, fresh, and could be shown now. */
  ready(): boolean;
  showing(): boolean;
  /** Start loading an ad if there is none and none is on its way. */
  load(): void;
  /**
   * Show the loaded ad. Always settles, never rejects.
   * interstitial: true if the ad was on screen. rewarded: true only if the reward was earned.
   */
  show(): Promise<boolean>;
  /** Feed a plugin event for this slot. */
  handle(event: FullscreenEvent): void;
  /** The app came back to the foreground. */
  onActive(): void;
}

interface Session {
  displayed: boolean;
  earned: boolean;
  done: boolean;
  beatTimer: unknown;
  graceTimer: unknown;
  /** Time the page has been running since show() was entered, or since the ad appeared. */
  runningMs: number;
  lastBeatAt: number;
  finish(reason: string): void;
}

type State = 'empty' | 'loading' | 'ready' | 'showing';

/** What showRewardVideoAd resolves with when, and only when, the reward was earned. */
function isRewardItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as { type?: unknown; amount?: unknown };
  return typeof item.amount === 'number' || typeof item.type === 'string';
}

export function createFullscreenSlot(kind: FullscreenKind, driver: FullscreenDriver, host: FullscreenHost): FullscreenSlot {
  const { clock, log, tuning } = host;
  const maxOnScreenMs = kind === 'rewarded' ? tuning.maxRewardedShowMs : tuning.maxShowMs;

  let state: State = 'empty';
  let loadedAt = 0;
  let failures = 0;
  let loadId = 0;
  let retryTimer: unknown = null;
  let loadTimer: unknown = null;
  let session: Session | null = null;

  const cancel = (timer: unknown): null => {
    if (timer !== null) clock.clearTimeout(timer);
    return null;
  };

  const fresh = (): boolean => clock.now() - loadedAt < tuning.maxAdAgeMs;

  function markLoaded(): void {
    // While an ad is on screen a "loaded" can only belong to a load that was given up on.
    // The plugin keys prepared ads by ad unit id and deletes that entry on dismissal, so
    // such an ad would be gone again by the time it could be used: ignore it.
    if (state === 'showing') return;
    retryTimer = cancel(retryTimer);
    loadTimer = cancel(loadTimer);
    loadId++; // whatever load promise is still out there is now stale
    state = 'ready';
    loadedAt = clock.now();
    failures = 0;
  }

  function markLoadFailed(id: number, error: unknown): void {
    if (id !== loadId || state !== 'loading') return;
    loadTimer = cancel(loadTimer);
    state = 'empty';
    failures++;
    const delay = backoffDelay(failures, tuning.retryBaseMs, tuning.retryCapMs);
    log(`${kind}: load failed (${failures} in a row), next try in ${delay} ms`, error);
    retryTimer = cancel(retryTimer);
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      load();
    }, delay);
  }

  function load(): void {
    if (state !== 'empty' || !host.canLoad()) return;
    retryTimer = cancel(retryTimer);
    state = 'loading';
    const id = ++loadId;
    loadTimer = clock.setTimeout(() => {
      loadTimer = null;
      markLoadFailed(id, new Error('no answer from the ad SDK'));
    }, tuning.loadTimeoutMs);
    attempt(() => driver.load()).then(
      () => {
        // Usually the Loaded event got here first and already bumped loadId.
        if (id === loadId) markLoaded();
      },
      (error) => markLoadFailed(id, error),
    );
  }

  function ready(): boolean {
    if (state !== 'ready' || !host.canLoad()) return false;
    if (!fresh()) {
      // Too old to be shown: swap it for a new one.
      state = 'empty';
      load();
      return false;
    }
    return true;
  }

  /**
   * The watchdog of one showing: a timer that re-arms itself every heartbeatMs from the
   * moment show() is entered until finish(), adding up the time the page was really
   * running. JavaScript timers stand still while iOS has the app suspended (the player
   * followed the ad out to the App Store, or locked the phone) and all come due at once
   * afterwards, so a tick that arrives very late counts for maxBeatGapMs at most. Until
   * the ad reports that it is on screen the total is held against presentTimeoutMs, from
   * then on (starting again from zero) against maxShowMs (maxRewardedShowMs for a video).
   */
  function watch(s: Session): void {
    s.lastBeatAt = clock.now();
    const beat = (): void => {
      s.beatTimer = null;
      if (s.done) return;
      const now = clock.now();
      s.runningMs += Math.min(Math.max(now - s.lastBeatAt, 0), tuning.maxBeatGapMs);
      s.lastBeatAt = now;
      if (!s.displayed && s.runningMs >= tuning.presentTimeoutMs) s.finish('the ad never appeared');
      else if (s.displayed && s.runningMs >= maxOnScreenMs) s.finish('no dismissal reported');
      else s.beatTimer = clock.setTimeout(beat, tuning.heartbeatMs);
    };
    s.beatTimer = clock.setTimeout(beat, tuning.heartbeatMs);
  }

  /**
   * WHY THIS PROMISE ALWAYS SETTLES
   *
   * The game awaits show() before it lets the player continue, so a promise that stays
   * pending freezes the game. The plugin's own promise cannot be trusted with that (see
   * the notes at the top of this file: for a rewarded ad that is closed early it never
   * settles at all). So show() returns its own promise, and every way a showing can end
   * leads to the one idempotent finish():
   *
   *   1. nothing ready, or another full-screen ad is up  -> resolved false straight away
   *   2. the plugin rejects the show call                -> finish (false)
   *   3. FailedToShow event                              -> finish (false)
   *   4. Dismissed event                                 -> finish (interstitial: true;
   *                                                         rewarded: whether Rewarded was seen)
   *   5. no Showed event within presentTimeoutMs         -> finish (false). Covers the native
   *      path that never answers (no root view controller) and a lost event.
   *   6. Showed, but no Dismissed after maxShowMs (rewarded: maxRewardedShowMs) of running
   *      time -> finish. Covers a lost Dismissed event. If the ad is in fact still up, its
   *      late Dismissed is handled by strayEnd() below; a reward earned after this point is
   *      lost, which is why the limit for a video is the longer one.
   *
   * 5 and 6 are the watchdog above: one timer owned by this module, started synchronously
   * before the plugin is called. Each tick either ends the showing or schedules the next
   * tick, so from the first line of the executor until finish() a timer is always pending
   * that will end the showing, whatever the native side does or fails to do. finish()
   * resolves first and tidies up second, and nothing in here can reject.
   *
   * The reward: `earned` is set only by the Rewarded event or by the plugin's promise
   * resolving with a reward item, never by Dismissed. It lives on the Session object of
   * one showing and the promise resolves once, so a reward cannot be granted twice and a
   * late callback cannot leak into the next showing.
   */
  function show(): Promise<boolean> {
    if (!ready() || host.busy()) return Promise.resolve(false);
    state = 'showing';

    return new Promise<boolean>((resolve) => {
      const s: Session = {
        displayed: false,
        earned: false,
        done: false,
        beatTimer: null,
        graceTimer: null,
        runningMs: 0,
        lastBeatAt: 0,
        finish(reason) {
          if (s.done) return;
          s.done = true;
          const result = kind === 'rewarded' ? s.earned : s.displayed;
          try {
            resolve(result);
          } finally {
            s.beatTimer = cancel(s.beatTimer);
            s.graceTimer = cancel(s.graceTimer);
            if (session === s) session = null;
            state = 'empty';
            if (reason !== 'dismissed') log(`${kind}: showing ended: ${reason}`);
            // The ad that was shown (or failed to show) is used up: fetch the next one.
            load();
          }
        },
      };
      session = s;

      watch(s);

      attempt(() => driver.show()).then(
        (value) => {
          // Interstitial: resolves when present() was called; says nothing about dismissal.
          // Rewarded: resolves with the reward item at the moment the reward is earned.
          if (kind === 'rewarded' && isRewardItem(value)) rewardEarned(s);
        },
        (error) => {
          log(`${kind}: the plugin refused to show`, error);
          s.finish('show call rejected');
        },
      );
    });
  }

  function rewardEarned(s: Session): void {
    if (s.done) return;
    s.earned = true;
    // Already closed and only waiting out the grace period: no need to wait any longer.
    if (s.graceTimer !== null) s.finish('dismissed');
  }

  function handle(event: FullscreenEvent): void {
    if (event === 'loaded') {
      markLoaded();
      return;
    }
    const s = session;
    if (!s || s.done) {
      // An event for a showing that is already over, or that this page never started.
      if (event === 'dismissed' || event === 'failedToShow') strayEnd();
      return;
    }
    switch (event) {
      case 'showed':
        if (!s.displayed) {
          s.displayed = true;
          // The watchdog now measures time on screen, from zero.
          s.runningMs = 0;
          s.lastBeatAt = clock.now();
        }
        break;
      case 'rewarded':
        if (kind === 'rewarded') rewardEarned(s);
        break;
      case 'failedToShow':
        s.displayed = false; // whatever was reported before, the player did not get to see an ad
        s.finish('failed to show');
        break;
      case 'dismissed':
        s.displayed = true; // it cannot be closed without having been open
        if (kind === 'rewarded' && !s.earned) {
          // The SDK reports the reward before the dismissal, and so does the plugin. Should
          // the two ever arrive the other way round, a short wait still catches the reward.
          if (s.graceTimer === null) {
            s.graceTimer = clock.setTimeout(() => {
              s.graceTimer = null;
              s.finish('dismissed');
            }, tuning.rewardGraceMs);
          }
        } else {
          s.finish('dismissed');
        }
        break;
    }
  }

  /**
   * An ad of this kind closed (or failed to open) while no showing is live here. That is an
   * ad this slot had stopped waiting for: one the watchdog released while it was in fact
   * still up, or one that a previous page of the app put up before the web view reloaded.
   *
   * With that event the plugin has deleted whatever was prepared for this ad unit (see the
   * notes at the top of this file), and that is the ad loaded since, the one `ready` stands
   * for. Showing it would be refused, so fetch another.
   *
   * A load still under way is left alone: the plugin files that ad when the load completes,
   * after the deletion, and the Loaded event for it has not been sent yet.
   */
  function strayEnd(): void {
    if (state !== 'ready') return;
    log(`${kind}: an ad closed that was no longer being waited for; loading a new one`);
    state = 'empty';
    load();
  }

  function onActive(): void {
    if (state === 'empty') {
      // Do not sit out the rest of a long backoff: the network may be back.
      retryTimer = cancel(retryTimer);
      load();
    } else if (state === 'ready') {
      ready(); // replaces the ad if it went stale while the app was away
    }
  }

  return { kind, ready, showing: () => state === 'showing', load, show, handle, onActive };
}
