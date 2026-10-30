const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const TRANSITIONS = Object.freeze({
  queued: new Set(['planning', 'cancelled']),
  planning: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['reviewing', 'quality', 'failed', 'cancelled', 'interrupted']),
  reviewing: new Set(['repairing', 'quality', 'failed', 'cancelled', 'interrupted']),
  repairing: new Set(['running', 'reviewing', 'quality', 'failed', 'cancelled', 'interrupted']),
  quality: new Set(['repairing', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  succeeded: new Set(), failed: new Set(), cancelled: new Set(), interrupted: new Set(),
});

export class TransitionError extends Error {
  constructor(from, to, reason) {
    super(`cannot transition from ${from} to ${to}${reason ? `: ${reason}` : ''}`);
    this.name = 'TransitionError';
    this.from = from;
    this.to = to;
  }
}

export function createRunState({ status = 'queued', reviews = 0, repairs = 0 } = {}) {
  if (!TRANSITIONS[status]) throw new TypeError(`unknown orchestration state: ${status}`);
  if (!Number.isSafeInteger(reviews) || reviews < 0 || !Number.isSafeInteger(repairs) || repairs < 0) {
    throw new TypeError('review and repair counts must be non-negative integers');
  }
  return Object.freeze({ status, reviews, repairs });
}

export function transition(state, to, { reviewLimit = 2, repairLimit = 3 } = {}) {
  const current = createRunState(state);
  if (!TRANSITIONS[to]) throw new TypeError(`unknown orchestration state: ${to}`);
  if (!Number.isSafeInteger(reviewLimit) || reviewLimit < 1 || !Number.isSafeInteger(repairLimit) || repairLimit < 1) {
    throw new TypeError('transition limits must be positive integers');
  }
  if (!TRANSITIONS[current.status].has(to)) throw new TransitionError(current.status, to);
  let { reviews, repairs } = current;
  if (to === 'reviewing') {
    if (reviews >= reviewLimit) throw new TransitionError(current.status, to, 'review limit reached');
    reviews++;
  }
  if (to === 'repairing') {
    if (repairs >= repairLimit) throw new TransitionError(current.status, to, 'repair limit reached');
    repairs++;
  }
  return createRunState({ status: to, reviews, repairs });
}

export function isTerminal(state) {
  return TERMINAL.has(typeof state === 'string' ? state : state?.status);
}

export { TRANSITIONS as ORCHESTRATION_TRANSITIONS };
