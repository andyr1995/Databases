import type { ShareOptions, SharePlugin } from '@capacitor/share';
import type { SharePayload, ShareResult } from './types.ts';
import { attempt, errorText } from './util.ts';

export type ShareLike = Pick<SharePlugin, 'share'>;

/**
 * How a dismissed share sheet is signalled (read from the plugin sources, 8.0.3):
 *  - iOS  SharePlugin.swift: completionWithItemsHandler with completed == false -> call.reject("Share canceled")
 *  - Android SharePlugin.java: RESULT_CANCELED -> call.reject("Share canceled")
 *  - the web fallback rejects with the browser's AbortError
 * There is no error code, so the message is all there is to go on.
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
 * present). Resolves once the sheet has closed. Never rejects.
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
