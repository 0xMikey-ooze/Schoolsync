// Reference implementation of processAssignments used ONLY by the verification
// harness when LLM_PIPELINE_PATH points here. This file lives under tests/ so
// the harness's default scan of source paths
// (server/orchestrator/llm-pipeline.*, src/lib/llm-pipeline.*) does NOT pick it
// up — i.e. its presence does not falsely turn the default harness run green.
//
// Purpose:
//   - Acts as a behavioral spec for the upstream "LLM Processing Pipeline" task.
//   - Lets us prove the harness's correctness + cache-hit assertions are
//     achievable (i.e. the harness itself is not over-constrained).
//
// Cache contract: a stable cache key derived from the raw assignment ids,
// due_at, submission state, and nowISO. Two identical invocations must hit
// the cache and skip llmCall.

function cacheKey(rawAssignments, nowISO) {
  const sig = rawAssignments
    .map(a => `${a.id}|${a.due_at || ''}|${a.submission?.workflow_state || ''}|${a.submission?.submitted_at || ''}`)
    .sort()
    .join(';');
  return `${nowISO}::${sig}`;
}

function isOverdue(a, nowMs) {
  if (!a.due_at) return false;
  const due = Date.parse(a.due_at);
  if (Number.isNaN(due)) return false;
  if (due >= nowMs) return false;
  const submitted = a.submission?.submitted_at || a.submission?.workflow_state === 'submitted';
  return !submitted;
}

export async function processAssignments(rawAssignments, { now, llmCall, cache } = {}) {
  if (!Array.isArray(rawAssignments)) throw new Error('rawAssignments must be an array');
  if (!now) throw new Error('now (ISO string) is required');
  if (typeof llmCall !== 'function') throw new Error('llmCall function is required');
  const store = cache instanceof Map ? cache : null;

  const key = cacheKey(rawAssignments, now);
  if (store && store.has(key)) return store.get(key);

  const nowMs = Date.parse(now);
  const items = rawAssignments.map(a => ({
    id: a.id,
    courseName: a.course?.name || '',
    dueAt: a.due_at || null,
    isOverdue: isOverdue(a, nowMs),
  }));

  const llmOut = await llmCall('categorize-assignments', { assignments: rawAssignments });

  for (const item of items) {
    for (const [subject, ids] of Object.entries(llmOut.subjectBuckets || {})) {
      if (ids.includes(item.id)) {
        item.subject = subject;
        break;
      }
    }
    if (!item.subject) item.subject = 'Other';
  }

  const result = {
    items,
    subjectBuckets: llmOut.subjectBuckets,
    deadlineSummary: llmOut.deadlineSummary,
  };
  if (store) store.set(key, result);
  return result;
}
