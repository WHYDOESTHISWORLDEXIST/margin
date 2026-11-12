// Pause detection, kept free of the VS Code API so it can be tested in Node.
//
// A "natural pause" is a stretch with no typing, the end of a paragraph, or
// switching away from the editor. "Stalled" is a long stretch of little
// progress: either no typing at all, or mostly deleting.

class PauseTracker {
  constructor({ pauseMs = 8000, stuckMs = 180000, now = () => Date.now() } = {}) {
    this.pauseMs = pauseMs;
    this.stuckMs = stuckMs;
    this.now = now;
    this.lastEdit = now();
    this.events = []; // { t, inserted, deleted }
    this.forcedPause = false;
  }

  recordEdit(inserted, deleted, endsParagraph = false) {
    const t = this.now();
    this.lastEdit = t;
    this.events.push({ t, inserted, deleted });
    const cutoff = t - this.stuckMs;
    while (this.events.length && this.events[0].t < cutoff) this.events.shift();
    this.forcedPause = endsParagraph;
  }

  recordBlur() {
    this.forcedPause = true;
  }

  idleMs() {
    return this.now() - this.lastEdit;
  }

  isPaused() {
    return this.forcedPause || this.idleMs() >= this.pauseMs;
  }

  // Little net progress over the window: long idle, or deleting at least as
  // much as was written while still fiddling with the text.
  isStalled() {
    // Only after some writing in this session, so reading isn't mistaken for a stall.
    if (!this.events.length) return false;
    if (this.idleMs() >= this.stuckMs) return true;
    const t = this.now();
    const recent = this.events.filter((e) => e.t >= t - this.stuckMs);
    if (recent.length < 20) return false;
    const spanMs = t - recent[0].t;
    if (spanMs < this.stuckMs * 0.8) return false;
    const inserted = recent.reduce((s, e) => s + e.inserted, 0);
    const deleted = recent.reduce((s, e) => s + e.deleted, 0);
    return deleted >= inserted * 0.8;
  }
}

// Whether the status bar shows the quiet break offer. It shows while it's
// wanted (the writer seems stalled) and the window has focus. Once it has been
// on screen for seenMs with the window focused, it counts as seen: from then
// on, typing, leaving the window or the stall ending hides it, and after showMs
// on screen in all it hides by itself. Each time a seen offer hides, or the
// writer chooses from the break menu, it stays away for snoozeMs.
class BreakOffer {
  constructor({ seenMs = 30000, showMs = 120000, snoozeMs = 20 * 60000, now = () => Date.now() } = {}) {
    this.seenMs = seenMs;
    this.showMs = showMs;
    this.snoozeMs = snoozeMs;
    this.now = now;
    this.visible = false;
    this.shownMs = 0; // on screen, window focused, during this stall
    this.lastUpdate = now();
    this.snoozedUntil = 0;
  }

  // Call often (the companion does once a second). Returns whether to show it.
  update(wanted, focused) {
    const t = this.now();
    if (this.visible) this.shownMs += t - this.lastUpdate;
    this.lastUpdate = t;
    if (this.visible && this.shownMs >= this.showMs) this.snooze();
    const show = Boolean(wanted && focused) && t >= this.snoozedUntil;
    if (!show && this.visible && this.shownMs >= this.seenMs) this.snooze();
    if (!wanted) this.shownMs = 0; // the stall ended before the offer was seen: start afresh
    this.visible = show;
    return show;
  }

  seen() {
    return this.visible && this.shownMs + (this.now() - this.lastUpdate) >= this.seenMs;
  }

  // The writer typed: a seen offer goes away. One not yet seen stays while the
  // stall lasts (mostly deleting is typing too).
  typed() {
    if (this.seen()) this.snooze();
  }

  // The writer opened the break menu.
  clicked() {
    this.snooze();
  }

  snooze() {
    this.snoozedUntil = this.now() + this.snoozeMs;
    this.visible = false;
    this.shownMs = 0;
  }
}

// True when an edit just finished a paragraph: a newline typed right after
// sentence-ending punctuation.
function endsParagraph(previousLineText, insertedText) {
  return /\n/.test(insertedText) && /[.!?"”')\]]\s*$/.test(previousLineText);
}

module.exports = { PauseTracker, BreakOffer, endsParagraph };
