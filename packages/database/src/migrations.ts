import type Database from 'better-sqlite3'

export interface Migration {
  version: number
  name: string
  /** Package that owns the tables this migration defines. */
  owner: `@numenjs/${string}`
  up(database: Database.Database): void
}

export const coreMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'core-durable-domain',
    owner: '@numenjs/automation',
    up(database) {
      database.exec(`
        CREATE TABLE automations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          active_revision_id TEXT,
          activation_generation INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE automation_drafts (
          automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
          base_revision_id TEXT,
          source_json TEXT NOT NULL,
          presentation_json TEXT NOT NULL DEFAULT '{}',
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE automation_revisions (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
          number INTEGER NOT NULL,
          protocol_version INTEGER NOT NULL,
          source_json TEXT NOT NULL,
          presentation_json TEXT NOT NULL DEFAULT '{}',
          ir_version INTEGER NOT NULL,
          compiled_plan_json TEXT NOT NULL,
          dependency_manifest_json TEXT NOT NULL,
          contract_snapshot_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (automation_id, number)
        );

        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id),
          revision_id TEXT NOT NULL REFERENCES automation_revisions(id),
          status TEXT NOT NULL CHECK (status IN (
            'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLING', 'CANCELLED'
          )),
          trigger_json TEXT NOT NULL,
          input_json TEXT NOT NULL,
          group_key TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );

        CREATE INDEX runs_dispatch_idx ON runs(status, created_at);
        CREATE INDEX runs_automation_idx ON runs(automation_id, created_at DESC);

        CREATE TABLE executions (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          instruction_id TEXT NOT NULL,
          parent_execution_id TEXT REFERENCES executions(id),
          status TEXT NOT NULL CHECK (status IN (
            'RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED', 'COMPLETED', 'FAILED',
            'CANCELLING', 'CANCELLED', 'TIMED_OUT'
          )),
          resolved_input_json TEXT,
          output_json TEXT,
          wake_at TEXT,
          generation INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX executions_dispatch_idx ON executions(status, wake_at, updated_at);
        CREATE INDEX executions_run_idx ON executions(run_id, created_at);

        CREATE TABLE attempts (
          id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
          number INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED',
            'INTERRUPTED', 'OUTCOME_UNKNOWN'
          )),
          provider_ref TEXT NOT NULL,
          error_json TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          UNIQUE (execution_id, number)
        );

        CREATE TABLE run_events (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          PRIMARY KEY (run_id, sequence)
        );
      `)
    },
  },
  {
    version: 2,
    name: 'execution-block-reason',
    owner: '@numenjs/scheduler',
    up(database) {
      database.exec(`
        ALTER TABLE executions ADD COLUMN blocked_reason TEXT;
        CREATE INDEX executions_blocked_idx ON executions(status, blocked_reason, updated_at);
      `)
    },
  },
  {
    version: 3,
    name: 'run-cancellation-intent',
    owner: '@numenjs/scheduler',
    up(database) {
      database.exec(`
        ALTER TABLE runs ADD COLUMN cancel_reason TEXT;
        CREATE INDEX runs_cancelling_idx ON runs(status, created_at);
      `)
    },
  },
  {
    version: 4,
    name: 'durable-trigger-events',
    owner: '@numenjs/triggers',
    up(database) {
      database.exec(`
        CREATE TABLE trigger_events (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id),
          revision_id TEXT NOT NULL REFERENCES automation_revisions(id),
          activation_generation INTEGER NOT NULL,
          trigger_id TEXT NOT NULL,
          capability_id TEXT NOT NULL,
          capability_version INTEGER NOT NULL,
          event_id TEXT,
          subject TEXT,
          data_json TEXT NOT NULL,
          checkpoint_json TEXT,
          occurred_at TEXT NOT NULL,
          accepted_at TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX trigger_events_dedupe_idx
          ON trigger_events(revision_id, trigger_id, event_id)
          WHERE event_id IS NOT NULL;
        CREATE INDEX trigger_events_automation_idx
          ON trigger_events(automation_id, accepted_at DESC);
      `)
    },
  },
  {
    version: 5,
    name: 'connection-configs',
    owner: '@numenjs/connections',
    up(database) {
      database.exec(`
        CREATE TABLE connections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          adapter_id TEXT NOT NULL,
          adapter_version INTEGER NOT NULL,
          config_json TEXT NOT NULL,
          credential_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          generation INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX connections_adapter_idx
          ON connections(adapter_id, adapter_version, enabled);
      `)
    },
  },
  {
    version: 6,
    name: 'encrypted-credentials',
    owner: '@numenjs/credentials',
    up(database) {
      database.exec(`
        CREATE TABLE credentials (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type_id TEXT NOT NULL,
          type_version INTEGER NOT NULL,
          ciphertext BLOB NOT NULL,
          nonce BLOB NOT NULL,
          key_id TEXT NOT NULL,
          secret_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX credentials_type_idx
          ON credentials(type_id, type_version, updated_at DESC);
      `)
    },
  },
  {
    version: 7,
    name: 'resource-lifecycle',
    owner: '@numenjs/resources',
    up(database) {
      database.exec(`
        CREATE TABLE resources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL CHECK (size >= 0),
          digest TEXT NOT NULL,
          store_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('STAGED', 'COMMITTED', 'DELETING', 'GONE')),
          staged_expires_at TEXT,
          gc_after TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          gone_at TEXT
        );

        CREATE INDEX resources_gc_idx
          ON resources(state, staged_expires_at, gc_after);
        CREATE INDEX resources_digest_idx
          ON resources(digest, state);

        CREATE TABLE resource_owners (
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (resource_id, owner_type, owner_id)
        );

        CREATE INDEX resource_owners_owner_idx
          ON resource_owners(owner_type, owner_id);

        CREATE TABLE resource_leases (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
          holder TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX resource_leases_expiry_idx
          ON resource_leases(resource_id, expires_at);
      `)
    },
  },
  {
    version: 8,
    name: 'execution-scopes',
    owner: '@numenjs/scheduler',
    up(database) {
      database.exec(`
        ALTER TABLE executions
          ADD COLUMN scope_execution_id TEXT REFERENCES executions(id);
        CREATE INDEX executions_scope_idx
          ON executions(scope_execution_id, status, created_at);
      `)
    },
  },
  {
    version: 9,
    name: 'execution-scope-branches',
    owner: '@numenjs/scheduler',
    up(database) {
      database.exec(`
        ALTER TABLE executions ADD COLUMN scope_branch INTEGER;
        CREATE INDEX executions_scope_branch_idx
          ON executions(scope_execution_id, scope_branch, status);
      `)
    },
  },
  {
    version: 10,
    name: 'durable-iterations',
    owner: '@numenjs/scheduler',
    up(database) {
      database.exec(`
        ALTER TABLE executions ADD COLUMN loop_item_json TEXT;
        ALTER TABLE executions ADD COLUMN loop_index INTEGER;

        CREATE TABLE execution_iterations (
          iterate_execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
          item_index INTEGER NOT NULL,
          item_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'
          )),
          root_execution_id TEXT REFERENCES executions(id),
          terminal_execution_id TEXT REFERENCES executions(id),
          error_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (iterate_execution_id, item_index)
        );

        CREATE INDEX execution_iterations_dispatch_idx
          ON execution_iterations(iterate_execution_id, status, item_index);
      `)
    },
  },
  {
    version: 11,
    name: 'automation-draft-copy-requests',
    owner: '@numenjs/automation',
    up(database) {
      database.exec(`
        CREATE TABLE automation_draft_copy_requests (
          request_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE
        );
      `)
    },
  },
  {
    version: 12,
    name: 'manual-run-requests',
    owner: '@numenjs/scheduler',
    up(database) {
      database.exec(`
        CREATE TABLE manual_run_requests (
          request_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE
        );
      `)
    },
  },
  {
    version: 13,
    name: 'connection-types',
    owner: '@numenjs/connections',
    up(database) {
      database.exec(`
        ALTER TABLE connections ADD COLUMN type_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE connections ADD COLUMN type_version INTEGER NOT NULL DEFAULT 1;
        CREATE INDEX connections_type_idx
          ON connections(type_id, type_version, enabled);
      `)
    },
  },
  {
    version: 14,
    name: 'automation-archives',
    owner: '@numenjs/automation',
    up(database) {
      database.exec('ALTER TABLE automations ADD COLUMN archived_at TEXT;')
      database.exec('CREATE INDEX automations_archive_idx ON automations(archived_at, updated_at DESC);')
    },
  },
  {
    version: 15,
    name: 'draft-test-execution-snapshots',
    owner: '@numenjs/automation',
    up(database) {
      const { version } = database.prepare('SELECT sqlite_version() AS version').get() as { version: string }
      const [major = 0, minor = 0] = version.split('.').map(Number)
      if (major < 3 || (major === 3 && minor < 53)) {
        throw new Error(`draft test snapshot migration requires SQLite 3.53 or later; found ${version}`)
      }
      // The bundled SQLite supports this DDL without rebuilding the parent table,
      // preserving every downstream foreign key and the publication UNIQUE index.
      database.exec(`
        ALTER TABLE automation_revisions ALTER COLUMN number DROP NOT NULL;
        ALTER TABLE automation_revisions ADD COLUMN source_draft_version INTEGER;
        ALTER TABLE automation_revisions ADD COLUMN base_revision_id TEXT;
        ALTER TABLE automation_revisions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'published'
          CHECK (
            (purpose = 'published' AND typeof(number) = 'integer' AND number > 0
              AND (source_draft_version IS NULL OR
                (typeof(source_draft_version) = 'integer' AND source_draft_version > 0)))
            OR
            (purpose = 'draft-test' AND number IS NULL
              AND typeof(source_draft_version) = 'integer' AND source_draft_version > 0)
          );
      `)
    },
  },
  {
    version: 16,
    name: 'durable-graph-members',
    owner: '@numenjs/scheduler',
    up(database) {
      database.exec(`
        CREATE TABLE graph_members (
          scope_execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          execution_id TEXT UNIQUE REFERENCES executions(id) ON DELETE CASCADE,
          skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (scope_execution_id, node_id),
          CHECK (execution_id IS NULL OR skipped = 0)
        );
      `)
    },
  },
  {
    version: 17,
    name: 'immutable-output-samples-and-local-tests',
    owner: '@numenjs/automation',
    up(database) {
      database.exec(`
        CREATE TABLE automation_output_samples (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          sample_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX automation_output_samples_node_idx ON automation_output_samples(automation_id, node_id, created_at, id);
        ALTER TABLE automation_revisions ADD COLUMN local_test_json TEXT CHECK (local_test_json IS NULL OR purpose = 'draft-test');
        ALTER TABLE executions ADD COLUMN sample_id TEXT;
      `)
    },
  },
  {
    version: 18,
    name: 'durable-run-admission',
    owner: '@numenjs/scheduler',
    up(database) {
      database.exec(`
        CREATE TABLE run_admissions (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
          max_active INTEGER CHECK (max_active IS NULL OR (
            typeof(max_active) = 'integer' AND max_active > 0 AND max_active <= 9007199254740991
          )),
          overflow TEXT NOT NULL CHECK (overflow IN ('queue', 'drop', 'replace')),
          namespace TEXT NOT NULL CHECK (namespace IN ('formal', 'test')),
          replacement_requested INTEGER NOT NULL DEFAULT 0 CHECK (replacement_requested IN (0, 1))
        );
        CREATE INDEX runs_admission_group_idx ON runs(automation_id, group_key, status);
      `)
    },
  },
  {
    version: 19,
    name: 'durable-run-attention-and-origins',
    owner: '@numenjs/scheduler',
    up(database) {
      database.exec(`
        CREATE TABLE run_attentions (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK (kind IN ('FAILED', 'OUTCOME_UNKNOWN')),
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          automation_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL,
          execution_identity TEXT NOT NULL DEFAULT '',
          attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
          occurred_at TEXT NOT NULL,
          acknowledged_at TEXT,
          summary TEXT NOT NULL,
          historical INTEGER NOT NULL DEFAULT 0 CHECK (historical IN (0, 1)),
          UNIQUE (run_id, kind, execution_identity)
        );
        CREATE INDEX run_attentions_inbox_idx ON run_attentions(acknowledged_at, sequence DESC);
        CREATE INDEX run_attentions_automation_idx ON run_attentions(automation_id, sequence DESC);
        CREATE TABLE attention_deliveries (
          attention_id TEXT NOT NULL REFERENCES run_attentions(id) ON DELETE CASCADE,
          automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
          trigger_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'SKIPPED')),
          run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          accepted_at TEXT,
          summary TEXT,
          PRIMARY KEY (automation_id, trigger_id, attention_id)
        );
        CREATE INDEX attention_deliveries_pending_idx ON attention_deliveries(automation_id, trigger_id, status, created_at);
        CREATE TABLE run_origins (
          run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('attention', 'replay')),
          source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          source_run_identity TEXT NOT NULL,
          attention_id TEXT REFERENCES run_attentions(id) ON DELETE SET NULL,
          suppress_attention INTEGER NOT NULL CHECK (suppress_attention IN (0, 1))
        );
        CREATE TABLE replay_requests (
          request_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE
        );
      `)
      // Historical records are visible in the inbox but deliberately have no deliveries.
      const runs = database.prepare(`
        SELECT runs.id, runs.automation_id, runs.revision_id, runs.status,
          runs.finished_at, runs.created_at, automation_revisions.purpose, run_admissions.namespace
        FROM runs JOIN automation_revisions ON automation_revisions.id = runs.revision_id
        LEFT JOIN run_admissions ON run_admissions.run_id = runs.id
      `).all() as Array<{ id: string; automation_id: string; revision_id: string; status: string; finished_at: string | null; created_at: string; purpose: string; namespace: string | null }>
      const insert = database.prepare(`INSERT OR IGNORE INTO run_attentions
        (id, kind, run_id, automation_id, revision_id, execution_id, execution_identity, attempt_id, occurred_at, summary, historical)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      for (const run of runs) {
        const accepted = database.prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'RunAccepted' ORDER BY sequence LIMIT 1`).get(run.id) as { payload_json: string } | undefined
        let acceptedSource: unknown
        try { acceptedSource = accepted ? JSON.parse(accepted.payload_json)?.source : undefined } catch { /* Old receipts can be absent or invalid. */ }
        if (run.namespace === 'test' || run.purpose === 'draft-test' || ['revision-test', 'draft-test', 'local-test'].includes(String(acceptedSource))) continue
        if (run.status === 'FAILED') {
          insert.run(`attention_legacy_failed_${run.id}`, 'FAILED', run.id, run.automation_id, run.revision_id, null, '', null,
            run.finished_at ?? run.created_at, 'The Run failed. Inspect the execution details before running it again.')
        }
        const unknown = database.prepare(`SELECT executions.id, executions.updated_at, MIN(run_events.occurred_at) AS first_at
          FROM executions LEFT JOIN run_events ON run_events.run_id = executions.run_id
            AND json_valid(run_events.payload_json)
            AND json_extract(run_events.payload_json, '$.executionId') = executions.id
            AND (run_events.type = 'AttemptOutcomeUnknown' OR (run_events.type = 'ExecutionBlocked' AND json_extract(run_events.payload_json, '$.reason') = 'OUTCOME_UNKNOWN'))
          WHERE executions.run_id = ? AND (executions.blocked_reason = 'OUTCOME_UNKNOWN' OR run_events.sequence IS NOT NULL)
          GROUP BY executions.id`).all(run.id) as Array<{ id: string; updated_at: string; first_at: string | null }>
        for (const execution of unknown) {
          insert.run(`attention_legacy_unknown_${execution.id}`, 'OUTCOME_UNKNOWN', run.id, run.automation_id, run.revision_id,
            execution.id, execution.id, null, execution.first_at ?? execution.updated_at,
            'An execution outcome is unknown. Verify the external result before cancelling or running it again.')
        }
      }
    },
  },
]

export function runMigrations(
  database: Database.Database,
  migrations: readonly Migration[] = coreMigrations,
): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const appliedRows = database
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string }>
  const applied = new Map(appliedRows.map(row => [row.version, row.name]))

  const supportedVersion = Math.max(0, ...migrations.map(migration => migration.version))
  const currentVersion = Math.max(0, ...applied.keys())
  if (currentVersion > supportedVersion) {
    throw new Error(`unsupported database schema version ${currentVersion}; maximum supported is ${supportedVersion}`)
  }

  for (const migration of migrations) {
    const existingName = applied.get(migration.version)
    if (existingName && existingName !== migration.name) {
      throw new Error(
        `migration ${migration.version} was applied as ${existingName}, expected ${migration.name}`,
      )
    }
  }

  const apply = database.transaction((migration: Migration) => {
    migration.up(database)
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, new Date().toISOString())
  })

  let count = 0
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue
    apply.immediate(migration)
    count += 1
  }
  return count
}
