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
 *
 * Android (HapticsPlugin.java and arguments/*.java, 8.0.2) takes the same five calls and
 * plays fixed vibrator waveforms for them, as duration @ strength out of 255:
 *   LIGHT 50 ms @ 110, MEDIUM 43 ms @ 180, HEAVY 60 ms @ 255,
 *   SUCCESS 35 ms @ 250, 65 ms off, 21 ms @ 180; ERROR 27 ms @ 120, 45 ms off, 50 ms @ 250.
 * A phone whose motor has no strength control plays them at full strength, so there the
 * three taps differ only in length. An unknown style falls back to HEAVY and an unknown type
 * to SUCCESS natively, which is why only the five known values are ever sent. The calls
 * always resolve; the VIBRATE permission they need comes with the plugin's manifest.
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
