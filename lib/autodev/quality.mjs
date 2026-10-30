function normalizeCheck(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`quality check ${index} must be an object`);
  const name = String(value.name ?? '').trim();
  if (!name) throw new TypeError(`quality check ${index} requires a name`);
  return Object.freeze({
    name,
    passed: value.passed === true,
    required: value.required !== false,
    detail: typeof value.detail === 'string' ? value.detail.trim() : '',
    observed: value.observed === true,
    ...(typeof value.packageId === 'string' && value.packageId ? { packageId: value.packageId } : {}),
  });
}

export function evaluateQualityGate({ checks = [], reviews = [] } = {}) {
  if (!Array.isArray(checks) || !Array.isArray(reviews)) throw new TypeError('checks and reviews must be arrays');
  const normalizedChecks = checks.map(normalizeCheck);
  const failedChecks = normalizedChecks.filter(
    (check) => check.required && (check.passed !== true || check.observed !== true),
  );
  const blockingFindings = reviews.flatMap((review) => review.findings ?? []).filter((finding) => finding.blocking);
  const reasons = [
    ...failedChecks.map((check) => check.observed !== true
      ? `quality check was not host-observed: ${check.name}`
      : `quality check failed: ${check.name}`),
    ...blockingFindings.map((finding) => `blocking review finding: ${finding.id ?? finding.title}`),
  ];
  return Object.freeze({
    passed: reasons.length === 0,
    checks: Object.freeze(normalizedChecks),
    failedChecks: Object.freeze(failedChecks),
    blockingFindings: Object.freeze(blockingFindings),
    reasons: Object.freeze(reasons),
  });
}
