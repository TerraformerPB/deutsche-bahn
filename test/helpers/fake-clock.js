/**
 * Fake-Uhr mit Fake-Timern für deterministische Tests ohne echtes Warten.
 *
 * `now()` liefert die simulierte Zeit, `setTimeout`/`clearTimeout` registrieren
 * Timer, die durch `advance(ms)` (synchron) bzw. `advanceAsync(ms)` (mit
 * Microtask-Flush nach jedem Timer) ausgelöst werden.
 */
export function createFakeClock(start = 1_700_000_000_000) {
  let t = start;
  let seq = 0;
  /** @type {Map<number, {at:number, fn:() => void, seq:number}>} */
  const timers = new Map();

  function nextDue(limit) {
    let best = null;
    for (const [id, timer] of timers) {
      if (timer.at <= limit && (best === null || timer.at < best.timer.at || (timer.at === best.timer.at && timer.seq < best.timer.seq))) {
        best = { id, timer };
      }
    }
    return best;
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, Number(ms) || 0), fn, seq: id });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** Zeit vorstellen und fällige Timer synchron ausführen. */
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = nextDue(target);
        if (!due) break;
        timers.delete(due.id);
        t = due.timer.at;
        due.timer.fn();
      }
      t = target;
    },
    /** Wie `advance`, aber nach jedem Timer werden Promises/Microtasks abgearbeitet. */
    async advanceAsync(ms) {
      const target = t + ms;
      await flush();
      for (;;) {
        const due = nextDue(target);
        if (!due) break;
        timers.delete(due.id);
        t = due.timer.at;
        due.timer.fn();
        await flush();
      }
      t = target;
      await flush();
    },
    /** Wartet nur auf Microtasks/Immediates, ohne die Zeit zu verändern. */
    flush,
    pending: () => timers.size,
    /** Verzögerungen der offenen Timer (relativ zu jetzt), aufsteigend. */
    pendingDelays: () => Array.from(timers.values()).map((x) => x.at - t).sort((a, b) => a - b),
  };
}
