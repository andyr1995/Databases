import type { ShareOptions, SharePlugin } from '@capacitor/share';
import type { SharePayload, ShareResult } from './types.ts';
import { attempt, errorText } from './util.ts';

export type ShareLike = Pick<SharePlugin, 'share'>;

/**
 * How a dismissed share sheet is signalled (read from the plugin sources, 8.0.3):
 *  - iOS  SharePlugin.swift: completionWithItemsHandler with completed == false -> call.reject("Share canceled")
 *  - Android SharePlugin.java: call.reject("Share canceled") when the chooser comes back
 *    with RESULT_CANCELED and the game's activity was never stopped meanwhile
 *  - the web fallback rejects with the browser's AbortError
 * There is no error code, so the message is all there is to go on.
 *
 * Android's chooser returns RESULT_CANCELED whatever the player did, so the plugin goes by
 * whether another app came to the front (the game's activity was stopped). Two consequences:
 *  - an action that stays on the sheet, above all its own "Copy" button, is reported as
 *    cancelled although the text was copied. The game shows nothing for 'cancelled', and
 *    Android confirms the copy itself.
 *  - the answer only arrives when the player is back in the game. Nothing may wait on it.
 */
function isCancellation(error: unknown): boolean {
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  return name === 'AbortError' || /cancel/i.test(errorText(error));
}

/**
 * platform.share(payload): the native share sheet.
 *
 * Like the web version, the link is appended to the text and sent as one string, so every
 * share target receives both (several targets drop the text when a separate URL item is
 * present). The title becomes the subject where the target has one (e-mail). Resolves once
 * the sheet has closed (Android: once the player is back in the game). Never rejects.
 */
export function createShare(share: ShareLike): (payload: SharePayload) => Promise<ShareResult> {
  return async (payload) => {
    try {
      const text = payload && typeof payload.text === 'string' ? payload.text : '';
      const url = payload && typeof payload.url === 'string' ? payload.url : '';
      const full = url ? (text ? `${text}\n${url}` : url) : text;
      if (!full) return 'failed';
      const options: ShareOptions = { text: full };
      if (payload.title) options.title = payload.title;
      await attempt(() => share.share(options));
      return 'shared';
    } catch (error) {
      return isCancellation(error) ? 'cancelled' : 'failed';
    }
  };
}
