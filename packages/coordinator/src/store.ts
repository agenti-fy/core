import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ulid } from 'ulid';
import {
  JobOutcomeSchema,
  JobRecordStatusSchema,
  METHODS,
  PERSONA_TYPES,
  STATUSES,
  type AgentRecord,
  type JobOutcome,
  type JobRecord,
  type JobRecordStatus,
  type Method,
  type RegisterRequest,
  type RepoRecord,
  type Status,
} from '@agentify/shared';

/* ========================================================================== */
/*                              Schema migrations                              */
/* ========================================================================== */

interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

const sqlList = (vals: readonly string[]): string => vals.map((v) => `'${v}'`).join(',');

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial-schema',
    up: (db) => {
      // Derive CHECK constraint values from the canonical Zod enums so that
      // adding a new status/outcome anywhere updates here automatically.
      const allowedStatuses = sqlList(STATUSES);
      const allowedMethods = sqlList(METHODS);
      const allowedJobStatus = sqlList(JobRecordStatusSchema.options);
      const allowedOutcomes = sqlList(JobOutcomeSchema.options);

      db.exec(`
        CREATE TABLE agents (
          agent_id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          type TEXT NOT NULL,
          version TEXT NOT NULL,
          url TEXT NOT NULL,
          supported_methods TEXT NOT NULL,
          registered_at INTEGER NOT NULL,
          last_heartbeat INTEGER,
          last_known_status TEXT CHECK (last_known_status IS NULL OR last_known_status IN (${allowedStatuses}))
        );

        CREATE TABLE sessions (
          agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
          repo TEXT NOT NULL,
          session_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (agent_id, repo)
        );

        CREATE TABLE jobs (
          job_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          method TEXT NOT NULL CHECK (method IN (${allowedMethods})),
          repo TEXT NOT NULL,
          target_id INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN (${allowedJobStatus})),
          outcome TEXT CHECK (outcome IS NULL OR outcome IN (${allowedOutcomes})),
          dispatched_at INTEGER NOT NULL,
          completed_at INTEGER,
          result_json TEXT
        );

        CREATE UNIQUE INDEX jobs_unique_active
          ON jobs(repo, method, target_id)
          WHERE status IN ('dispatched','running');

        CREATE INDEX jobs_by_agent ON jobs(agent_id, status);
        CREATE INDEX jobs_by_completed_at ON jobs(completed_at) WHERE status IN ('complete','failed');

        CREATE TABLE repos (
          repo TEXT PRIMARY KEY,
          poll_interval_s INTEGER NOT NULL DEFAULT 30,
          active INTEGER NOT NULL DEFAULT 1,
          last_polled INTEGER
        );

        CREATE TABLE control (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    id: 2,
    name: 'agents-type-check',
    up: (db) => {
      // Defense-in-depth: migration #1 left agents.type as unconstrained TEXT,
      // relying on the Zod boundary. Anyone writing directly to SQLite (tests,
      // manual SQL) could persist a bad type and the runtime would happily
      // serve it. SQLite can't ALTER TABLE ADD CHECK, so do the standard
      // recreate-and-swap dance, preserving rows.
      const allowedTypes = sqlList(PERSONA_TYPES);
      db.exec(`
        CREATE TABLE agents_new (
          agent_id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          type TEXT NOT NULL CHECK (type IN (${allowedTypes})),
          version TEXT NOT NULL,
          url TEXT NOT NULL,
          supported_methods TEXT NOT NULL,
          registered_at INTEGER NOT NULL,
          last_heartbeat INTEGER,
          last_known_status TEXT CHECK (last_known_status IS NULL OR last_known_status IN (${sqlList(
            STATUSES,
          )}))
        );
        INSERT INTO agents_new SELECT * FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_new RENAME TO agents;
      `);
    },
  },
  {
    id: 3,
    name: 'jobs-failed-dispatch-index',
    up: (db) => {
      // gcJobs filters `status='failed_to_dispatch' AND dispatched_at < ?`.
      // jobs_by_completed_at covers the complete/failed branch but not this
      // one — without an index, GC scans the full table. Partial index keeps
      // it tiny in steady state (failed_to_dispatch should be rare).
      db.exec(`
        CREATE INDEX IF NOT EXISTS jobs_failed_dispatch
          ON jobs(dispatched_at)
          WHERE status = 'failed_to_dispatch';
      `);
    },
  },
  {
    id: 4,
    name: 'jobs-agent-dispatched-index',
    up: (db) => {
      // pickIdleAgent's hot path joins MAX(dispatched_at) GROUPED BY agent_id.
      // Without this covering index it has to scan every row and aggregate.
      // After months of operation with thousands of jobs/day, this becomes
      // the bottleneck on dispatch latency. With (agent_id, dispatched_at DESC)
      // SQLite can do a single index seek per group.
      db.exec(`
        CREATE INDEX IF NOT EXISTS jobs_agent_dispatched
          ON jobs(agent_id, dispatched_at DESC);
      `);
    },
  },
  {
    id: 6,
    name: 'jobs-persona-name-column',
    up: (db) => {
      // Combined-label routing (`agent:<persona>:<method>`) lets a single
      // target carry multiple in-flight jobs for different personas (e.g. four
      // reviewers on one PR). The old unique partial index keyed only on
      // (repo, method, target_id) collided. Add `persona_name` to the row,
      // re-key the partial unique index to include it.
      db.exec(`
        ALTER TABLE jobs ADD COLUMN persona_name TEXT NOT NULL DEFAULT '';
        DROP INDEX IF EXISTS jobs_unique_active;
        CREATE UNIQUE INDEX jobs_unique_active
          ON jobs(repo, persona_name, method, target_id)
          WHERE status IN ('dispatched','running');
      `);
    },
  },
  {
    id: 7,
    name: 'dep-blocked-targets',
    up: (db) => {
      // Tracks issues the work-poller has skipped because at least one declared
      // `Depends on:` reference was still open. The poller's since=lastPolled
      // filter only returns issues whose updated_at moved — closing a dep PR
      // updates the dep's row but NOT the dependent's, so without this table
      // unblocked issues stay invisible to the poller forever.
      //
      // Each tick the poller iterates this table and explicitly fetches each
      // entry by number, re-evaluating the dep gate. Routes when satisfied;
      // clears the entry when the issue is closed/relabeled.
      db.exec(`
        CREATE TABLE dep_blocked (
          repo TEXT NOT NULL,
          target_id INTEGER NOT NULL,
          blocked_at INTEGER NOT NULL,
          PRIMARY KEY (repo, target_id)
        );
        CREATE INDEX dep_blocked_by_repo ON dep_blocked(repo);
      `);
    },
  },
  {
    id: 8,
    name: 'plans',
    up: (db) => {
      // Records the parent→children relationship produced by every successful
      // plan-skill run so a later loop can auto-close the parent when all its
      // children are closed. completed_at IS NULL means the plan is still open.
      db.exec(`
        CREATE TABLE plans (
          repo TEXT NOT NULL,
          parent_id INTEGER NOT NULL,
          child_ids TEXT NOT NULL CHECK (json_valid(child_ids)),
          recorded_at INTEGER NOT NULL,
          completed_at INTEGER,
          last_checked_at INTEGER,
          PRIMARY KEY (repo, parent_id)
        );
        CREATE INDEX plans_open ON plans(completed_at) WHERE completed_at IS NULL;
      `);
    },
  },
  {
    id: 5,
    name: 'agents-supported-methods-json-check',
    up: (db) => {
      // pickIdleAgent's SQL uses `json_each(a.supported_methods)`. Invalid
      // JSON in that column raises a SQLite error that propagates up through
      // the dispatcher and crashes the entire batch — one corrupt row poisons
      // every subsequent dispatch attempt. Adding `json_valid()` as a CHECK
      // makes the bad state impossible to insert in the first place. SQLite
      // can't ALTER ADD CHECK, so the recreate-and-swap dance again.
      const allowedTypes = sqlList(PERSONA_TYPES);
      db.exec(`
        CREATE TABLE agents_new (
          agent_id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          type TEXT NOT NULL CHECK (type IN (${allowedTypes})),
          version TEXT NOT NULL,
          url TEXT NOT NULL,
          supported_methods TEXT NOT NULL CHECK (json_valid(supported_methods)),
          registered_at INTEGER NOT NULL,
          last_heartbeat INTEGER,
          last_known_status TEXT CHECK (last_known_status IS NULL OR last_known_status IN (${sqlList(
            STATUSES,
          )}))
        );
        INSERT INTO agents_new SELECT * FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_new RENAME TO agents;
      `);
    },
  },
];

function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );`);

  const applied = new Set(
    db
      .prepare<[], { id: number }>('SELECT id FROM schema_migrations')
      .all()
      .map((r) => r.id),
  );

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
  );

  // Apply in id order regardless of array order — array reordering is a
  // common refactor that should NEVER change the migration sequence.
  const ordered = [...MIGRATIONS].sort((a, b) => a.id - b.id);
  for (const m of ordered) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      insertMigration.run(m.id, m.name, Date.now());
    })();
  }
}

/* ========================================================================== */
/*                                Row helpers                                  */
/* ========================================================================== */

interface AgentRow {
  agent_id: string;
  name: string;
  type: string;
  version: string;
  url: string;
  supported_methods: string;
  registered_at: number;
  last_heartbeat: number | null;
  last_known_status: string | null;
}

interface JobRow {
  job_id: string;
  agent_id: string;
  method: string;
  repo: string;
  target_id: number;
  /** Routing-label persona segment — see DispatchRequest.persona_name. */
  persona_name: string;
  status: string;
  outcome: string | null;
  dispatched_at: number;
  completed_at: number | null;
  result_json: string | null;
}

interface RepoRow {
  repo: string;
  poll_interval_s: number;
  active: number;
  last_polled: number | null;
}

interface PlanRow {
  repo: string;
  parent_id: number;
  child_ids: string;
  recorded_at: number;
  completed_at: number | null;
  last_checked_at: number | null;
}

export interface PlanRecord {
  repo: string;
  parent_id: number;
  child_ids: number[];
  recorded_at: number;
  last_checked_at: number | null;
}

function rowToAgent(row: AgentRow): AgentRecord {
  // Defensive parse: malformed supported_methods JSON would propagate up
  // through pickIdleAgentForPersona/listAgents and fail the whole dispatch
  // batch. Fall back to []; the agent simply won't match any method until
  // its next register() call rewrites the column.
  let supported_methods: Method[] = [];
  try {
    const parsed: unknown = JSON.parse(row.supported_methods);
    if (Array.isArray(parsed)) supported_methods = parsed as Method[];
  } catch {
    // bad JSON in DB — leave empty
  }
  return {
    agent_id: row.agent_id,
    name: row.name,
    type: row.type as AgentRecord['type'],
    version: row.version,
    url: row.url,
    supported_methods,
    registered_at: row.registered_at,
    last_heartbeat: row.last_heartbeat,
    last_known_status: row.last_known_status as Status | null,
  };
}

function rowToJob(row: JobRow): JobRecord {
  return {
    job_id: row.job_id,
    agent_id: row.agent_id,
    method: row.method as Method,
    repo: row.repo,
    target_id: row.target_id,
    persona_name: row.persona_name,
    status: row.status as JobRecordStatus,
    outcome: row.outcome as JobOutcome | null,
    dispatched_at: row.dispatched_at,
    completed_at: row.completed_at,
    result_json: row.result_json,
  };
}

function rowToRepo(row: RepoRow): RepoRecord {
  return {
    repo: row.repo,
    poll_interval_s: row.poll_interval_s,
    active: row.active === 1,
    last_polled: row.last_polled,
  };
}

function rowToPlan(row: PlanRow): PlanRecord {
  let child_ids: number[] = [];
  try {
    const parsed: unknown = JSON.parse(row.child_ids);
    if (Array.isArray(parsed)) child_ids = parsed as number[];
  } catch {
    // bad JSON in DB — leave empty
  }
  return {
    repo: row.repo,
    parent_id: row.parent_id,
    child_ids,
    recorded_at: row.recorded_at,
    last_checked_at: row.last_checked_at,
  };
}

/* ========================================================================== */
/*                                  Store                                      */
/* ========================================================================== */

export class CoordinatorStore {
  private readonly db: Database.Database;
  private readonly stmts: ReturnType<typeof prepareStatements>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db);
    // Prepare every hot-path statement once. better-sqlite3 caches the parsed
    // query plan inside the Statement; reusing it is ~10x cheaper than calling
    // prepare() per request, which matters on the dispatch hot path.
    this.stmts = prepareStatements(this.db);
  }

  close(): void {
    this.db.close();
  }

  /* -------------------- agents -------------------- */

  /**
   * Register or re-register an agent. New agents start as IDLE so the
   * dispatcher can route to them immediately. Re-registering also resets
   * `last_known_status` to IDLE — a fresh process is by definition idle.
   */
  registerAgent(req: RegisterRequest): AgentRecord {
    const now = Date.now();
    const existing = this.stmts.selectAgentByName.get({ name: req.name });

    if (existing) {
      this.stmts.updateAgentOnReregister.run({
        agent_id: existing.agent_id,
        type: req.type,
        version: req.version,
        url: req.url,
        supported_methods: JSON.stringify(req.supported_methods),
        now,
      });
      return {
        agent_id: existing.agent_id,
        name: existing.name,
        type: req.type,
        version: req.version,
        url: req.url,
        supported_methods: req.supported_methods,
        registered_at: existing.registered_at,
        last_heartbeat: now,
        last_known_status: 'IDLE',
      };
    }

    const agent_id = ulid();
    this.stmts.insertAgent.run({
      agent_id,
      name: req.name,
      type: req.type,
      version: req.version,
      url: req.url,
      supported_methods: JSON.stringify(req.supported_methods),
      now,
    });

    return {
      agent_id,
      name: req.name,
      type: req.type,
      version: req.version,
      url: req.url,
      supported_methods: req.supported_methods,
      registered_at: now,
      last_heartbeat: now,
      last_known_status: 'IDLE',
    };
  }

  listAgents(): AgentRecord[] {
    return this.stmts.listAgents.all().map(rowToAgent);
  }

  getAgent(agent_id: string): AgentRecord | null {
    const row = this.stmts.selectAgentById.get({ agent_id });
    return row ? rowToAgent(row) : null;
  }

  getAgentByName(name: string): AgentRecord | null {
    const row = this.stmts.selectAgentByName.get({ name });
    return row ? rowToAgent(row) : null;
  }

  /**
   * Delete an agent row, atomically marking any active (`dispatched`/`running`)
   * jobs as `failed` with `outcome='orphaned'`. Without that fixup the active
   * rows would survive forever — invisible to the job-completion-poller
   * (which iterates `listAgents()`, so deleted agents are skipped) and
   * untouched by `gcJobs` (which only handles `failed_to_dispatch` /
   * `complete` / `failed`). `hasActiveJob` would then return true for those
   * `(repo, method, target_id)` triples indefinitely, silently blocking any
   * future dispatch for the same target. Returns true if a row was deleted.
   */
  deleteAgent(agent_id: string): boolean {
    const tx = this.db.transaction(() => {
      this.stmts.markActiveJobsOrphanedForAgent.run({
        agent_id,
        now: Date.now(),
        result_json: JSON.stringify({ error: 'agent deleted while job active' }),
      });
      return this.stmts.deleteAgent.run({ agent_id }).changes > 0;
    });
    return tx();
  }

  /**
   * Update last_heartbeat + last_known_status for an agent. Returns true if
   * a row was matched, false if the agent_id doesn't exist. Hot endpoints
   * (the `/agents/:id/heartbeat` route) use the boolean to short-circuit a
   * separate `getAgent` lookup; callers that already hold an agent record
   * (the dispatcher, the job-poller) can ignore it.
   */
  recordHeartbeat(agent_id: string, status: Status): boolean {
    return this.stmts.recordHeartbeat.run({ agent_id, now: Date.now(), status }).changes > 0;
  }

  /**
   * Pick an IDLE agent matching the given persona label segment AND supporting
   * the requested method. Built-in personas match on `type`; custom names
   * match on `name` (with type='custom'). Round-robins by oldest
   * last-dispatched-at. Returns null if no candidate is available.
   */
  pickIdleAgentForPersona(personaName: string, method: Method): AgentRecord | null {
    const row = this.stmts.pickIdleAgent.get({ persona: personaName, method });
    return row ? rowToAgent(row) : null;
  }

  /**
   * True if there's already an active job (dispatched/running) for this
   * (persona, method, target) tuple. The persona is part of the key now —
   * skeptic and conductor reviewing the same PR are distinct active jobs.
   */
  hasActiveJob(
    repo: string,
    persona_name: string,
    method: Method,
    target_id: number,
  ): boolean {
    const row = this.stmts.hasActiveJob.get({ repo, persona_name, method, target_id });
    return (row?.e ?? 0) > 0;
  }

  /* -------------------- sessions -------------------- */

  getSession(agent_id: string, repo: string): string | null {
    return this.stmts.getSession.get({ agent_id, repo })?.session_id ?? null;
  }

  upsertSession(agent_id: string, repo: string, session_id: string): void {
    this.stmts.upsertSession.run({ agent_id, repo, session_id, now: Date.now() });
  }

  /* -------------------- jobs -------------------- */

  insertJob(job: Omit<JobRecord, 'completed_at' | 'result_json' | 'outcome'>): void {
    this.stmts.insertJob.run(job);
  }

  updateJobStatus(
    job_id: string,
    status: JobRecordStatus,
    fields?: { outcome?: JobOutcome | null; result_json?: string | null; completed_at?: number },
  ): void {
    this.stmts.updateJobStatus.run({
      job_id,
      status,
      outcome: fields?.outcome ?? null,
      result_json: fields?.result_json ?? null,
      completed_at: fields?.completed_at ?? null,
    });
  }

  listOpenJobs(limit = 500): JobRecord[] {
    return this.stmts.listOpenJobs.all({ limit }).map(rowToJob);
  }

  listRecentJobs(limit = 100): JobRecord[] {
    return this.stmts.listRecentJobs.all({ limit }).map(rowToJob);
  }

  listRunningJobsForAgent(agent_id: string): JobRecord[] {
    return this.stmts.listRunningJobsForAgent.all({ agent_id }).map(rowToJob);
  }

  listJobsForAgent(agent_id: string, limit = 50): JobRecord[] {
    return this.stmts.listJobsForAgent.all({ agent_id, limit }).map(rowToJob);
  }

  /** Periodic GC. Returns the number of rows deleted. */
  gcJobs(opts: { failedDispatchOlderThanMs: number; completedOlderThanMs: number }): number {
    const now = Date.now();
    return this.stmts.gcJobs.run({
      failedCut: now - opts.failedDispatchOlderThanMs,
      completedCut: now - opts.completedOlderThanMs,
    }).changes;
  }

  /* -------------------- repos -------------------- */

  upsertRepo(repo: string, poll_interval_s: number, active: boolean): void {
    this.stmts.upsertRepo.run({ repo, poll_interval_s, active: active ? 1 : 0 });
  }

  recordRepoPoll(repo: string, when: number = Date.now()): void {
    this.stmts.recordRepoPoll.run({ repo, when });
  }

  listRepos(): RepoRecord[] {
    return this.stmts.listRepos.all().map(rowToRepo);
  }

  getRepo(repo: string): RepoRecord | null {
    const row = this.stmts.getRepo.get({ repo });
    return row ? rowToRepo(row) : null;
  }

  /** Repos due for polling: active AND (last_polled IS NULL OR last_polled + interval <= now). */
  listReposDueForPoll(now: number = Date.now()): RepoRecord[] {
    return this.stmts.listReposDueForPoll.all({ now }).map(rowToRepo);
  }

  /* -------------------- dep_blocked -------------------- */

  /**
   * Mark an issue as dep-blocked so the next tick re-checks it explicitly.
   * Idempotent — re-marking refreshes blocked_at for diagnostic purposes only.
   */
  markDepBlocked(repo: string, target_id: number, when: number = Date.now()): void {
    this.stmts.markDepBlocked.run({ repo, target_id, when });
  }

  /** Drop the dep-blocked entry. Idempotent. */
  clearDepBlocked(repo: string, target_id: number): void {
    this.stmts.clearDepBlocked.run({ repo, target_id });
  }

  /** Issue numbers currently dep-blocked in this repo. */
  listDepBlockedForRepo(repo: string): number[] {
    return this.stmts.listDepBlockedForRepo.all({ repo }).map((r) => r.target_id);
  }

  /* -------------------- plans -------------------- */

  /**
   * Record or refresh the parent→children plan produced by a plan-skill run.
   * On re-plan: overwrites child_ids, refreshes recorded_at, and resets
   * completed_at to NULL so the auto-close loop re-evaluates the plan.
   */
  upsertPlan(repo: string, parent_id: number, child_ids: number[]): void {
    this.stmts.upsertPlan.run({ repo, parent_id, child_ids: JSON.stringify(child_ids), now: Date.now() });
  }

  /** All plans where completed_at IS NULL. */
  listOpenPlans(): PlanRecord[] {
    return this.stmts.listOpenPlans.all().map(rowToPlan);
  }

  /** Set completed_at. Idempotent — safe to call on an already-complete plan. */
  markPlanComplete(repo: string, parent_id: number, when: number = Date.now()): void {
    this.stmts.markPlanComplete.run({ repo, parent_id, when });
  }

  /** Bump last_checked_at for diagnostic / back-off purposes. */
  recordPlanCheck(repo: string, parent_id: number, when: number = Date.now()): void {
    this.stmts.recordPlanCheck.run({ repo, parent_id, when });
  }

  /* -------------------- control -------------------- */

  isHalted(): boolean {
    const row = this.stmts.getControl.get({ key: 'halted' });
    if (!row) return false;
    // Defensive against legacy / hand-edited values: any of these read as halted.
    const v = row.value.toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  }

  setHalted(halted: boolean): void {
    // Single conditional upsert — INSERT-or-UPDATE-when-changed avoids the
    // SELECT+UPDATE round-trip that would otherwise churn updated_at on every
    // poll cycle when the value is unchanged.
    this.stmts.upsertControlIfChanged.run({
      key: 'halted',
      value: halted ? 'true' : 'false',
      now: Date.now(),
    });
  }
}

/* ========================================================================== */
/*                          Prepared statement bundle                          */
/* ========================================================================== */

function prepareStatements(db: Database.Database) {
  return {
    // agents
    selectAgentByName: db.prepare<{ name: string }, AgentRow>(
      'SELECT * FROM agents WHERE name = @name',
    ),
    selectAgentById: db.prepare<{ agent_id: string }, AgentRow>(
      'SELECT * FROM agents WHERE agent_id = @agent_id',
    ),
    listAgents: db.prepare<[], AgentRow>('SELECT * FROM agents ORDER BY name'),
    insertAgent: db.prepare(
      `INSERT INTO agents (agent_id, name, type, version, url, supported_methods, registered_at, last_heartbeat, last_known_status)
       VALUES (@agent_id, @name, @type, @version, @url, @supported_methods, @now, @now, 'IDLE')`,
    ),
    updateAgentOnReregister: db.prepare(
      `UPDATE agents
       SET type = @type, version = @version, url = @url,
           supported_methods = @supported_methods,
           last_heartbeat = @now,
           last_known_status = 'IDLE'
       WHERE agent_id = @agent_id`,
    ),
    deleteAgent: db.prepare('DELETE FROM agents WHERE agent_id = @agent_id'),
    /** Bulk-orphan active jobs for an agent that's about to be deleted. See
     *  `deleteAgent` for the rationale — without this fixup the rows would
     *  block future dispatches for their (repo, method, target_id) forever. */
    markActiveJobsOrphanedForAgent: db.prepare(
      `UPDATE jobs
       SET status = 'failed',
           outcome = 'orphaned',
           completed_at = @now,
           result_json = @result_json
       WHERE agent_id = @agent_id AND status IN ('dispatched','running')`,
    ),
    recordHeartbeat: db.prepare(
      'UPDATE agents SET last_heartbeat = @now, last_known_status = @status WHERE agent_id = @agent_id',
    ),

    // dispatcher hot path
    pickIdleAgent: db.prepare<
      { persona: string; method: string },
      AgentRow & { last_dispatched: number | null }
    >(
      `SELECT a.*, j.last_dispatched FROM agents a
       LEFT JOIN (
         SELECT agent_id, MAX(dispatched_at) AS last_dispatched
         FROM jobs GROUP BY agent_id
       ) j ON j.agent_id = a.agent_id
       WHERE a.last_known_status = 'IDLE'
         AND (a.type = @persona OR (a.type = 'custom' AND a.name = @persona))
         AND EXISTS (
           SELECT 1 FROM json_each(a.supported_methods) WHERE value = @method
         )
       ORDER BY j.last_dispatched ASC NULLS FIRST, a.name
       LIMIT 1`,
    ),
    hasActiveJob: db.prepare<
      { repo: string; persona_name: string; method: string; target_id: number },
      { e: number }
    >(
      `SELECT EXISTS(
         SELECT 1 FROM jobs
         WHERE repo = @repo
           AND persona_name = @persona_name
           AND method = @method
           AND target_id = @target_id
           AND status IN ('dispatched','running')
       ) AS e`,
    ),

    // sessions
    getSession: db.prepare<{ agent_id: string; repo: string }, { session_id: string }>(
      'SELECT session_id FROM sessions WHERE agent_id = @agent_id AND repo = @repo',
    ),
    upsertSession: db.prepare(
      `INSERT INTO sessions (agent_id, repo, session_id, updated_at)
       VALUES (@agent_id, @repo, @session_id, @now)
       ON CONFLICT(agent_id, repo) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    ),

    // jobs
    insertJob: db.prepare(
      `INSERT INTO jobs (job_id, agent_id, method, repo, target_id, persona_name, status, dispatched_at, outcome, completed_at, result_json)
       VALUES (@job_id, @agent_id, @method, @repo, @target_id, @persona_name, @status, @dispatched_at, NULL, NULL, NULL)`,
    ),
    updateJobStatus: db.prepare(
      `UPDATE jobs
       SET status = @status,
           outcome = COALESCE(@outcome, outcome),
           result_json = COALESCE(@result_json, result_json),
           completed_at = COALESCE(@completed_at, completed_at)
       WHERE job_id = @job_id`,
    ),
    listOpenJobs: db.prepare<{ limit: number }, JobRow>(
      `SELECT * FROM jobs WHERE status IN ('dispatched','running')
       ORDER BY dispatched_at LIMIT @limit`,
    ),
    listRecentJobs: db.prepare<{ limit: number }, JobRow>(
      `SELECT * FROM jobs WHERE status IN ('complete','failed')
       ORDER BY COALESCE(completed_at, dispatched_at) DESC LIMIT @limit`,
    ),
    listRunningJobsForAgent: db.prepare<{ agent_id: string }, JobRow>(
      `SELECT * FROM jobs WHERE agent_id = @agent_id AND status IN ('dispatched','running')
       ORDER BY dispatched_at`,
    ),
    listJobsForAgent: db.prepare<{ agent_id: string; limit: number }, JobRow>(
      `SELECT * FROM jobs WHERE agent_id = @agent_id
       ORDER BY dispatched_at DESC LIMIT @limit`,
    ),
    gcJobs: db.prepare(
      `DELETE FROM jobs WHERE
         (status = 'failed_to_dispatch' AND dispatched_at < @failedCut)
         OR (status IN ('complete','failed') AND COALESCE(completed_at, dispatched_at) < @completedCut)`,
    ),

    // repos
    upsertRepo: db.prepare(
      `INSERT INTO repos (repo, poll_interval_s, active)
       VALUES (@repo, @poll_interval_s, @active)
       ON CONFLICT(repo) DO UPDATE SET poll_interval_s = excluded.poll_interval_s, active = excluded.active`,
    ),
    recordRepoPoll: db.prepare('UPDATE repos SET last_polled = @when WHERE repo = @repo'),
    listRepos: db.prepare<[], RepoRow>('SELECT * FROM repos ORDER BY repo'),
    getRepo: db.prepare<{ repo: string }, RepoRow>('SELECT * FROM repos WHERE repo = @repo'),
    listReposDueForPoll: db.prepare<{ now: number }, RepoRow>(
      `SELECT * FROM repos
       WHERE active = 1
         AND (last_polled IS NULL OR last_polled + (poll_interval_s * 1000) <= @now)
       ORDER BY repo`,
    ),

    // dep_blocked
    markDepBlocked: db.prepare(
      `INSERT INTO dep_blocked (repo, target_id, blocked_at)
       VALUES (@repo, @target_id, @when)
       ON CONFLICT(repo, target_id) DO UPDATE SET blocked_at = excluded.blocked_at`,
    ),
    clearDepBlocked: db.prepare(
      'DELETE FROM dep_blocked WHERE repo = @repo AND target_id = @target_id',
    ),
    listDepBlockedForRepo: db.prepare<{ repo: string }, { target_id: number }>(
      'SELECT target_id FROM dep_blocked WHERE repo = @repo ORDER BY target_id',
    ),

    // plans
    upsertPlan: db.prepare(
      `INSERT INTO plans (repo, parent_id, child_ids, recorded_at, completed_at, last_checked_at)
       VALUES (@repo, @parent_id, @child_ids, @now, NULL, NULL)
       ON CONFLICT(repo, parent_id) DO UPDATE
         SET child_ids = excluded.child_ids,
             recorded_at = excluded.recorded_at,
             completed_at = NULL`,
    ),
    listOpenPlans: db.prepare<[], PlanRow>(
      `SELECT repo, parent_id, child_ids, recorded_at, last_checked_at, completed_at
       FROM plans WHERE completed_at IS NULL ORDER BY recorded_at`,
    ),
    markPlanComplete: db.prepare(
      `UPDATE plans SET completed_at = @when WHERE repo = @repo AND parent_id = @parent_id`,
    ),
    recordPlanCheck: db.prepare(
      `UPDATE plans SET last_checked_at = @when WHERE repo = @repo AND parent_id = @parent_id`,
    ),

    // control
    getControl: db.prepare<{ key: string }, { value: string }>(
      'SELECT value FROM control WHERE key = @key',
    ),
    /** INSERT-or-UPDATE-when-changed. Avoids churning updated_at on repeat
     *  setHalted(same-value) calls (every poll cycle when the halt label is
     *  observed, in particular). */
    upsertControlIfChanged: db.prepare(
      `INSERT INTO control (key, value, updated_at) VALUES (@key, @value, @now)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE control.value <> excluded.value`,
    ),
  };
}
