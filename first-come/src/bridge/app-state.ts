import type { AppPlugin } from '@capacitor/app';
import { attempt, type Logger, noop } from './util.ts';

export type AppLike = Pick<AppPlugin, 'addListener'>;

export type ActiveListener = (active: boolean) => void;

/**
 * One native 'appStateChange' subscription, fanned out to every interested party
 * (the game through platform.onActiveChange, and the ad provider for its retries).
 *
 * On iOS the App plugin sends isActive:true on UIApplication.didBecomeActive and
 * isActive:false on willResignActive. So `false` also arrives for short interruptions
 * that never reach the background: Control Center, the tracking prompt, the App Store
 * purchase sheet. Presenting a full-screen ad does not resign active.
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
