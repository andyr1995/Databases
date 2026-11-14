import type { AppPlugin } from '@capacitor/app';
import { attempt, type Logger, noop } from './util.ts';

export type AppLike = Pick<AppPlugin, 'addListener' | 'minimizeApp'>;

export type ActiveListener = (active: boolean) => void;

/**
 * One native 'appStateChange' subscription, fanned out to every interested party
 * (the game through platform.onActiveChange, and the ad provider for its retries).
 *
 * On iOS the App plugin sends isActive:true on UIApplication.didBecomeActive and
 * isActive:false on willResignActive. So `false` also arrives for short interruptions
 * that never reach the background: Control Center, the tracking prompt, the App Store
 * purchase sheet. Presenting a full-screen ad does not resign active.
 *
 * On Android (BridgeActivity.java of @capacitor/android 8.6.2, AppPlugin.java of
 * @capacitor/app 8.1.2) isActive:true is sent on EVERY Activity.onResume and isActive:false
 * on Activity.onStop. An activity is stopped only when it is completely covered, so:
 *  - Home, the app switcher, a Custom Tab, the app picked in the share sheet: false, then
 *    true on the way back.
 *  - the Google Play purchase sheet, the share sheet itself, a full-screen ad (AdActivity
 *    is declared with a translucent theme in the Google Mobile Ads manifest): the game's
 *    activity is paused but not stopped. No false; a second true when they close, which
 *    is dropped here as a repeat.
 *  - the first true of a launch is sent before any page can listen and is lost, as on iOS.
 */
export function createAppState(app: AppLike, log: Logger = noop): (cb: ActiveListener) => void {
  const listeners: ActiveListener[] = [];
  let subscribed = false;
  let last: boolean | null = null;

  const dispatch = (active: boolean): void => {
    if (active === last) return;
    last = active;
    for (const listener of listeners.slice()) {
      try {
        listener(active);
      } catch (error) {
        log('An onActiveChange listener threw', error);
      }
    }
  };

  const subscribe = (): void => {
    if (subscribed) return;
    subscribed = true;
    attempt(() => app.addListener('appStateChange', (state) => dispatch(!!(state && state.isActive)))).catch(
      (error) => {
        subscribed = false; // try again with the next subscriber
        log('App.addListener(appStateChange) failed', error);
      },
    );
  };

  return (cb) => {
    if (typeof cb !== 'function') return;
    listeners.push(cb);
    subscribe();
  };
}

/** Told `true` each time the game's Android activity is resumed, `false` each time it is paused. */
export type ActivityListener = (resumed: boolean) => void;

/**
 * Android only: the App plugin's 'pause' and 'resume' events, which follow Activity.onPause
 * and Activity.onResume one to one (AppPlugin.handleOnPause / handleOnResume; 'resume' is
 * only sent once the activity has been paused at least once).
 *
 * Unlike 'appStateChange' these also fire when something merely lies on top of the game:
 * above all a full-screen ad. "Paused, then resumed" therefore means "whatever covered the
 * game is gone", which fullscreen.ts uses to notice an ad that went away without a word.
 *
 * Nothing is subscribed until the first listener arrives, and never on another OS (there
 * the two events mean entering the background and coming back, which is not the same thing).
 */
export function createActivityWatch(app: AppLike, os: string, log: Logger = noop): (cb: ActivityListener) => void {
  const listeners: ActivityListener[] = [];
  let subscribed = false;

  const dispatch = (resumed: boolean): void => {
    for (const listener of listeners.slice()) {
      try {
        listener(resumed);
      } catch (error) {
        log('An activity listener threw', error);
      }
    }
  };

  const subscribe = (): void => {
    if (subscribed) return;
    subscribed = true;
    attempt(() => Promise.all([app.addListener('pause', () => dispatch(false)), app.addListener('resume', () => dispatch(true))])).catch(
      (error) => {
        subscribed = false;
        log('App.addListener(pause / resume) failed', error);
      },
    );
  };

  return (cb) => {
    if (os !== 'android' || typeof cb !== 'function') return;
    listeners.push(cb);
    subscribe();
  };
}

/**
 * platform.onBack(handler): Android's Back button and Back gesture.
 *
 * What the App plugin does (AppPlugin.java, 8.1.2): it holds an OnBackPressedCallback that
 * swallows every Back press. While the page has no 'backButton' listener the plugin steps
 * the web view back in its history, and does nothing at all when there is no history (this
 * game is a single page, so Back would be dead). As soon as a 'backButton' listener exists
 * the plugin does nothing itself and only sends the event: the page decides.
 *
 * So on Android the native listener is registered straight away, when the bridge is
 * installed, and not with the game's first handler: the game registers its handler late in
 * its start-up, and not at all on its "Something went wrong starting the game" screen, and
 * until then Back would do nothing. On each press the game's handler is asked, if there is
 * one; when there is none, or it returns false (or throws), the app is sent to the
 * background with App.minimizeApp(), which is Activity.moveTaskToBack(true): what Home does,
 * and what Android itself does for Back on a launcher activity since Android 12.
 * App.exitApp() would finish() the activity and throw away the page and the ads it holds.
 *
 * On any other OS this does nothing: no listener, no plugin call. Never throws.
 */
export function createOnBack(app: AppLike, os: string, log: Logger = noop): (handler: () => boolean) => void {
  let current: (() => boolean) | null = null;
  let subscribed = false;

  const pressed = (): void => {
    let handled = false;
    try {
      handled = current ? current() === true : false;
    } catch (error) {
      log('The onBack handler threw', error);
    }
    if (handled) return;
    attempt(() => app.minimizeApp()).catch((error) => log('App.minimizeApp failed', error));
  };

  const subscribe = (): void => {
    if (subscribed) return;
    subscribed = true;
    attempt(() => app.addListener('backButton', pressed)).catch((error) => {
      subscribed = false; // the next onBack() call tries again
      log('App.addListener(backButton) failed', error);
    });
  };

  if (os === 'android') subscribe();

  return (handler) => {
    if (os !== 'android') return;
    current = typeof handler === 'function' ? handler : null; // only one handler is kept
    subscribe();
  };
}
