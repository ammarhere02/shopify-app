/**
 * Purpose: Runs queued generation jobs (batches, or jobs whose inline run died) in the background.
 * Called by: entry.server.tsx once at boot; the loop then runs on a timer.
 * Input: QUEUED rows in ai_generation_jobs.
 * Output: Each leased job ends SUCCEEDED with a draft or FAILED with a reason.
 * Uses: ai-generation repository (lease), OpenRouter client via runGeneration.
 * Does not: Create jobs, call Shopify, or run more than one job per shop at a time.
 */
import { AiConfigError, loadAiConfig } from "../ai/config.server";
import { createOpenRouterClient } from "../ai/openrouter-client.server";
import { logger } from "../lib/logger.server";
import { failJob, leaseQueuedJob } from "../repositories/ai-generation.server";
import { prepareFromJob, runGeneration } from "./description-generation.server";
import type { RunDeps } from "./description-generation.server";

/**
 * Durable generation worker. Jobs are rows; this loop leases QUEUED rows one at a time and
 * runs them with the same `runGeneration` the inline path uses. Because the queue is the
 * database, a batch of jobs survives a restart, and the per-shop concurrency limit is enforced
 * where it matters (at run time) rather than at creation.
 *
 * Runs inside the web process (`startGenerationWorker` from entry.server) with one loop per
 * process. Several processes are safe: the lease uses `FOR UPDATE SKIP LOCKED`.
 * Jobs created by a request and run inline are left alone for `LEASE_GRACE_MS`; after that the
 * worker takes any QUEUED row, which also recovers a job whose inline run died with its process.
 */
export const POLL_MS = 2_000;
export const LEASE_GRACE_MS = 5_000;

export type WorkerDeps = { deps: RunDeps; maxRunningPerShop: number };

/** Lease and run at most one job. Returns true when a job was run (call again for the next). */
export async function workOnce(worker: WorkerDeps, now = new Date()) {
  const job = await leaseQueuedJob(worker.maxRunningPerShop, LEASE_GRACE_MS, now);
  if (!job) return false;
  const prepared = prepareFromJob(job);
  if (!prepared) {
    // Should not happen: every job is created with its input. Fail it visibly rather than loop.
    await failJob(job.shopId, job.id, "INTERNAL: job has no stored input").catch(() => undefined);
    logger.error("ai.worker_job_unrunnable", { shopId: job.shopId, jobId: job.id });
    return true;
  }
  logger.info("ai.worker_leased", { shopId: job.shopId, jobId: job.id, model: job.model });
  await runGeneration(worker.deps, job.shopId, job.id, prepared, { leased: true });
  return true;
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

/**
 * Start the polling loop once per process. Without OpenRouter configured the worker stays off
 * (queued jobs wait; the page already says "not configured"). Idempotent.
 */
export function startGenerationWorker(options: { pollMs?: number } = {}) {
  if (timer) return;
  let worker: WorkerDeps;
  try {
    const config = loadAiConfig();
    worker = { deps: { config, ai: createOpenRouterClient(config, { logContext: { worker: true } }) }, maxRunningPerShop: config.maxConcurrentPerShop };
  } catch (err) {
    if (err instanceof AiConfigError) {
      logger.warn("ai.worker_disabled", { reason: err.message });
      return;
    }
    throw err;
  }
  const tick = async () => {
    if (busy) return; // one lease at a time per process; the interval just re-checks
    busy = true;
    try {
      // Drain: keep leasing while there is due work, so a batch does not wait POLL_MS per job.
      while (await workOnce(worker)) {
        /* next */
      }
    } catch (err) {
      logger.error("ai.worker_tick_failed", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, options.pollMs ?? POLL_MS);
  timer.unref?.(); // never keep the process alive just for the worker
  logger.info("ai.worker_started", { pollMs: options.pollMs ?? POLL_MS, maxRunningPerShop: worker.maxRunningPerShop });
}

export function stopGenerationWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
