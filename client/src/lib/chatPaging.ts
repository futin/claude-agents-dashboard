/**
 * The chat drawer's paging bookkeeping, apart from React so it can be node-tested. `useSessionChat` owns the fetches; this owns the byte offsets and the two
 * rules that keep pages from landing twice or in the wrong transcript:
 *
 * - **One tail poll at a time.** `?after=` is stateless on the server, so two polls out with the same cursor return the same page and both would append it.
 *   A tick that finds one out is skipped — the next tick asks from wherever that one leaves the cursor.
 * - **An epoch per (re)tail.** Every request carries the epoch it was issued in; once `retail()` bumps it, an answer from before is dropped without touching
 *   the new tail's offsets or in-flight slots.
 */

/** The fields of a `SessionChat` page the bookkeeping reads. */
export interface ChatPageOffsets {
  cursor: number;
  headOffset: number;
  reset?: boolean;
  error?: boolean;
}

export interface ChatPaging {
  /** A (re)tail starts: offsets cleared, polls held until `tailLanded`, everything in flight now stale. Returns the tail's epoch. */
  retail(): number;
  /** The tail's newest page arrived; false when a later `retail()` superseded it. */
  tailLanded(epoch: number, page: Pick<ChatPageOffsets, 'cursor' | 'headOffset'>): boolean;
  /** A tick: the cursor to ask `?after=` from, or null while the tail hasn't landed or a poll is still out. */
  beginPoll(): { epoch: number; after: number } | null;
  /** `append` the page's messages, `reset` = re-tail, `drop` = ignore it (failed, errored, or from an older epoch). */
  endPoll(ticket: { epoch: number; after: number }, page: ChatPageOffsets | null): 'append' | 'reset' | 'drop';
  /** "Load older": the offset to ask `?before=` from, or null while one is out or there is no history above. */
  beginOlder(): { epoch: number; before: number } | null;
  /** `prepend` the page, `drop` it (failed or errored; the slot is free again), or `stale` — an older epoch's, whose slot is no longer its own. */
  endOlder(ticket: { epoch: number; before: number }, page: ChatPageOffsets | null): 'prepend' | 'drop' | 'stale';
}

export function createChatPaging(): ChatPaging {
  let epoch = 0;
  let cursor = 0;
  let head = 0;
  let ready = false;
  let polling = false;
  let older = false;
  return {
    retail() {
      epoch++;
      cursor = 0;
      head = 0;
      ready = false;
      polling = false;
      older = false;
      return epoch;
    },
    tailLanded(ep, page) {
      if (ep !== epoch) return false;
      cursor = page.cursor;
      head = page.headOffset;
      ready = true;
      return true;
    },
    beginPoll() {
      if (!ready || polling) return null;
      polling = true;
      return { epoch, after: cursor };
    },
    endPoll(ticket, page) {
      if (ticket.epoch !== epoch) return 'drop';
      polling = false;
      if (!page || page.error) return 'drop';
      if (page.reset) {
        ready = false;
        return 'reset';
      }
      cursor = page.cursor;
      return 'append';
    },
    beginOlder() {
      if (!ready || older || head <= 0) return null;
      older = true;
      return { epoch, before: head };
    },
    endOlder(ticket, page) {
      if (ticket.epoch !== epoch) return 'stale';
      older = false;
      if (!page || page.error) return 'drop';
      head = page.headOffset;
      return 'prepend';
    },
  };
}
