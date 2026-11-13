import type { HapticsPlugin, ImpactStyle, NotificationType } from '@capacitor/haptics';
import type { HapticKind } from './types.ts';
import { enumValue, noop } from './util.ts';

export type HapticsLike = Pick<HapticsPlugin, 'impact' | 'notification'>;

const LIGHT = enumValue<ImpactStyle.Light>('LIGHT');
const MEDIUM = enumValue<ImpactStyle.Medium>('MEDIUM');
const HEAVY = enumValue<ImpactStyle.Heavy>('HEAVY');
const SUCCESS = enumValue<NotificationType.Success>('SUCCESS');
const ERROR = enumValue<NotificationType.Error>('ERROR');

/**
 * platform.haptic(kind). The three touch strengths map to the Taptic Engine's three
 * impact weights, and the two outcomes to its success / error notification patterns.
 * Fire and forget: nothing is returned, nothing is thrown, no rejection escapes.
 */
export function createHaptic(haptics: HapticsLike): (kind: HapticKind) => void {
  return (kind) => {
    try {
      let pending: Promise<void>;
      switch (kind) {
        case 'success':
          pending = haptics.notification({ type: SUCCESS });
          break;
        case 'error':
          pending = haptics.notification({ type: ERROR });
          break;
        case 'heavy':
          pending = haptics.impact({ style: HEAVY });
          break;
        case 'soft':
          pending = haptics.impact({ style: MEDIUM });
          break;
        default:
          // 'tap', and anything unknown (the web version does the same)
          pending = haptics.impact({ style: LIGHT });
      }
      Promise.resolve(pending).catch(noop);
    } catch {
      /* haptics are decoration: never let them break a move */
    }
  };
}
