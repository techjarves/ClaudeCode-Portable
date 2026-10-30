export function buildReport(run, { tasks = [], reviews = [], quality = null, artifacts = [] } = {}) {
  if (!run || typeof run !== 'object' || typeof run.id !== 'string' || typeof run.status !== 'string') {
    throw new TypeError('a persisted run with id and status is required');
  }
  if (!Array.isArray(tasks) || !Array.isArray(reviews) || !Array.isArray(artifacts)) {
    throw new TypeError('report collections must be arrays');
  }
  const completed = tasks.filter((task) => task.status === 'succeeded');
  const failed = tasks.filter((task) => task.status === 'failed');
  const blocking = reviews.flatMap((review) => review.findings ?? []).filter((finding) => finding.blocking);
  const claimsSuccess = run.status === 'succeeded';
  const allTasksComplete = tasks.every((task) => task.status === 'succeeded');
  const verified = claimsSuccess && allTasksComplete && quality?.passed === true && blocking.length === 0;
  return Object.freeze({
    runId: run.id,
    status: run.status,
    successful: verified,
    summary: verified ? 'Completed and passed all recorded quality gates.' : `Run ended with status ${run.status}; success is not verified.`,
    tasks: Object.freeze({ total: tasks.length, completed: completed.length, failed: failed.length }),
    reviews: Object.freeze({ total: reviews.length, blocking: blocking.length }),
    quality: quality ? Object.freeze({ passed: quality.passed === true, reasons: Object.freeze([...(quality.reasons ?? [])]) }) : null,
    artifacts: Object.freeze(artifacts.map((artifact) => structuredClone(artifact))),
  });
}
