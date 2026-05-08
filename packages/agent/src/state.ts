import type {
  CurrentJob,
  FailureInfo,
  JobResult,
  Method,
  Status,
} from '@agenti-fy/shared';

export interface JobRecord {
  job_id: string;
  method: Method;
  repo: string;
  target_id: number;
  started_at: number;
  completed_at: number | null;
  result: JobResult | null;
}

/**
 * In-memory state for one running agent. The job history is bounded — once
 * past `capacity`, the oldest *completed* job is evicted. Active jobs are
 * never evicted.
 */
export class AgentState {
  private status: Status = 'IDLE';
  private currentJob: CurrentJob | null = null;
  private lastFailure: FailureInfo | null = null;
  private agentId: string | null = null;
  private readonly jobs = new Map<string, JobRecord>();
  /** FIFO of completed job ids in completion order, used for LRU eviction. */
  private completedOrder: string[] = [];
  /** Head index into completedOrder. Avoids O(N) Array.shift on every eviction. */
  private completedHead = 0;
  private readonly capacity: number;

  constructor(opts: { capacity?: number } = {}) {
    this.capacity = opts.capacity && opts.capacity > 0 ? opts.capacity : 500;
  }

  getStatus(): Status {
    return this.status;
  }
  getCurrentJob(): CurrentJob | null {
    return this.currentJob;
  }
  getLastFailure(): FailureInfo | null {
    return this.lastFailure;
  }
  getAgentId(): string | null {
    return this.agentId;
  }
  setAgentId(id: string): void {
    this.agentId = id;
  }

  startJob(job: CurrentJob): boolean {
    if (this.status !== 'IDLE') return false;
    this.status = 'BUSY';
    this.currentJob = job;
    this.jobs.set(job.id, {
      job_id: job.id,
      method: job.method,
      repo: job.repo,
      target_id: job.target_id,
      started_at: job.started_at,
      completed_at: null,
      result: null,
    });
    return true;
  }

  completeJob(result: JobResult): void {
    const rec = this.jobs.get(result.job_id);
    if (rec) {
      rec.result = result;
      rec.completed_at = Date.now();
      this.completedOrder.push(result.job_id);
      this.evictIfNeeded();
    }
    // Defensive: only flip global status/currentJob if we're completing the
    // ACTIVE job. A stale completion (duplicate retry, replay, etc.) for an
    // older job should record its result but NOT clobber the agent's current
    // state. Without this guard, a late completeJob(oldJob) call would flip
    // BUSY → IDLE while an unrelated job is still running — letting the next
    // dispatch barge into a busy agent.
    if (this.currentJob === null || this.currentJob.id !== result.job_id) {
      return;
    }
    this.currentJob = null;
    if (
      result.outcome === 'sdk_failure' ||
      result.outcome === 'auth_failure' ||
      result.outcome === 'config_failure'
    ) {
      this.status = 'FAILURE';
      this.lastFailure = {
        code: result.outcome,
        message: result.error?.message ?? 'unknown error',
        ts: Date.now(),
      };
    } else {
      this.status = 'IDLE';
    }
  }

  setFailure(info: FailureInfo): void {
    this.status = 'FAILURE';
    this.lastFailure = info;
    this.currentJob = null;
  }

  clearFailure(): void {
    if (this.status === 'FAILURE') this.status = 'IDLE';
    this.lastFailure = null;
  }

  getJob(job_id: string): JobRecord | null {
    return this.jobs.get(job_id) ?? null;
  }

  private evictIfNeeded(): void {
    while (this.completedOrder.length - this.completedHead > this.capacity) {
      const id = this.completedOrder[this.completedHead];
      this.completedHead++;
      if (id !== undefined) this.jobs.delete(id);
    }
    // Periodically compact when over half the array is dead head space.
    if (this.completedHead > 64 && this.completedHead * 2 >= this.completedOrder.length) {
      this.completedOrder = this.completedOrder.slice(this.completedHead);
      this.completedHead = 0;
    }
  }
}
