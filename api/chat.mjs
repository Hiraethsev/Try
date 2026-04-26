import { hasKvConfig } from './_lib/kv.mjs';
import {
  jsonResponse,
  markJobPending,
  normalizeChatJobPayload,
  processChatJob,
} from './_lib/ai-job.mjs';

export default async function handler(request, context) {
  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method Not Allowed.' }, 405);
  }

  if (!hasKvConfig()) {
    return jsonResponse(
      {
        ok: false,
        error:
          'Missing KV env vars. Configure KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN on Vercel.',
      },
      500,
    );
  }

  let input;

  try {
    input = await request.json();
  } catch (error) {
    return jsonResponse({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  let jobPayload;

  try {
    jobPayload = normalizeChatJobPayload(input);
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message || 'Invalid job payload.' }, 400);
  }

  await markJobPending(jobPayload);

  const task = processChatJob(jobPayload);

  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(task);
    return jsonResponse({ ok: true, accepted: true, jobId: jobPayload.jobId }, 202);
  }

  const result = await task;
  return jsonResponse(
    {
      ok: true,
      accepted: false,
      jobId: jobPayload.jobId,
      status: result.status,
    },
    200,
  );
}
