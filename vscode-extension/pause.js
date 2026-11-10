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

// True when an edit just finished a paragraph: a newline typed right after
// sentence-ending punctuation.
function endsParagraph(previousLineText, insertedText) {
  return /\n/.test(insertedText) && /[.!?"”')\]]\s*$/.test(previousLineText);
}

module.exports = { PauseTracker, endsParagraph };
