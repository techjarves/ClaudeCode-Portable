const SEVERITIES = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1, info: 0 });

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}
function backend(value, name) {
  const normalized=text(value,name).toLowerCase();
  if(!['claude','codex'].includes(normalized))throw new TypeError(`${name} must be claude or codex`);
  return normalized;
}

export function normalizeFinding(value, index = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`finding ${index} must be an object`);
  const severity = String(value.severity ?? '').toLowerCase();
  if (!(severity in SEVERITIES)) throw new TypeError(`finding ${index} has invalid severity`);
  const line = value.line == null ? null : Number(value.line);
  if (line !== null && (!Number.isSafeInteger(line) || line < 1)) throw new TypeError(`finding ${index} has invalid line`);
  return Object.freeze({
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `finding-${index + 1}`,
    severity,
    file: value.file == null ? null : text(value.file, `finding ${index} file`).replaceAll('\\', '/'),
    line,
    title: text(value.title ?? value.summary, `finding ${index} title`),
    detail: text(value.detail ?? value.description, `finding ${index} detail`),
    blocking: value.blocking == null ? SEVERITIES[severity] >= SEVERITIES.high : Boolean(value.blocking),
    ...(typeof value.packageId === 'string' && value.packageId ? { packageId: value.packageId } : {}),
  });
}

export function normalizeReview(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('review must be an object');
  const findings = (value.findings ?? []).map(normalizeFinding);
  findings.sort((a, b) => SEVERITIES[b.severity] - SEVERITIES[a.severity] || a.id.localeCompare(b.id));
  return Object.freeze({
    reviewer: text(value.reviewer, 'reviewer'),
    backend: backend(value.backend, 'review backend'),
    subjectBackend: backend(value.subjectBackend, 'subject backend'),
    ...(typeof value.packageId === 'string' && value.packageId ? { packageId: value.packageId } : {}),
    verdict: findings.some((finding) => finding.blocking) ? 'changes_requested' : 'approved',
    summary: typeof value.summary === 'string' ? value.summary.trim() : '',
    findings: Object.freeze(findings),
  });
}

export function normalizeReviews(values) {
  if (!Array.isArray(values)) throw new TypeError('reviews must be an array');
  return Object.freeze(values.map(normalizeReview));
}

export function requireCrossModelReview(value) {
  const review=normalizeReview(value);
  if(review.backend===review.subjectBackend)throw new TypeError('reviewer must use a different model backend');
  return review;
}

export { SEVERITIES as REVIEW_SEVERITIES };
