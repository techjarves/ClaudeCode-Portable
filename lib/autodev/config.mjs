const DEFAULTS = Object.freeze({ concurrency: 3, reviews: 2, repairs: 3 });

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

export function validateConfig(value = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('autodev config must be an object');
  }
  return Object.freeze({
    ...value,
    concurrency: positiveInteger(value.concurrency ?? DEFAULTS.concurrency, 'concurrency'),
    reviews: positiveInteger(value.reviews ?? DEFAULTS.reviews, 'reviews'),
    repairs: positiveInteger(value.repairs ?? DEFAULTS.repairs, 'repairs'),
  });
}

export { DEFAULTS as AUTODEV_DEFAULTS };
