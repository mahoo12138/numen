import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { coreMigrations, runMigrations } from '../src/migrations.js'
import { draftTestV14Ids as ids, populateDraftTestV14Fixture } from './fixtures/draft-test-v14.js'

function legacy(): Database.Database {
  const db = new Database(':memory:')
  populateDraftTestV14Fixture(db)
  runMigrations(db, coreMigrations.filter(item => item.version <= 18))
  return db
}

describe('run attention migration', () => {
  it('backfills historical formal failures and prior unknown outcomes without scheduling any delivery', () => {
    const db = legacy()
    try {
      db.prepare(`UPDATE runs SET status = 'FAILED' WHERE id = ?`).run(ids.completedRun)
      db.prepare(`UPDATE executions SET status = 'CANCELLED' WHERE id = 'exe_fixture_wait'`).run()
      db.prepare(`INSERT INTO run_events (run_id, sequence, type, payload_json, occurred_at) VALUES (?, 3, 'ExecutionBlocked', ?, '2026-10-01T10:00:00.000Z')`)
        .run(ids.waitingRun, JSON.stringify({ executionId: 'exe_fixture_wait', reason: 'OUTCOME_UNKNOWN', details: { error: 'private payload must not migrate' } }))
      // Older revision tests have no admission rows; their original acceptance receipt is authoritative.
      db.prepare(`UPDATE runs SET status = 'FAILED' WHERE id = ?`).run(ids.triggeredRun)
      db.prepare(`UPDATE run_events SET payload_json = '{"source":"revision-test"}' WHERE run_id = ? AND sequence = 1`).run(ids.triggeredRun)
      expect(runMigrations(db)).toBe(1)
      const records = db.prepare('SELECT * FROM run_attentions ORDER BY sequence').all() as Array<{ run_id: string; kind: string; historical: number }>
      expect(records).toHaveLength(2)
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ run_id: ids.completedRun, kind: 'FAILED', historical: 1 }),
        expect.objectContaining({ run_id: ids.waitingRun, kind: 'OUTCOME_UNKNOWN', historical: 1 }),
      ]))
      expect(JSON.stringify(records)).not.toContain('private payload')
      expect(db.prepare('SELECT * FROM attention_deliveries').all()).toEqual([])
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(runMigrations(db)).toBe(0)
      expect(db.prepare('SELECT COUNT(*) AS count FROM run_attentions').get()).toEqual({ count: 2 })
    } finally { db.close() }
  })

  it('atomically rolls back schema and backfill when migration commit fails', () => {
    const db = legacy()
    try {
      db.prepare(`UPDATE runs SET status = 'FAILED' WHERE id = ?`).run(ids.completedRun)
      db.exec(`CREATE TRIGGER prevent_attention_marker BEFORE INSERT ON schema_migrations WHEN NEW.version = 19 BEGIN SELECT RAISE(ABORT, 'migration interrupted'); END`)
      expect(() => runMigrations(db)).toThrow('migration interrupted')
      expect(db.prepare(`SELECT name FROM sqlite_schema WHERE name IN ('run_attentions', 'attention_deliveries', 'run_origins', 'replay_requests')`).all()).toEqual([])
      expect(db.prepare(`SELECT MAX(version) AS version FROM schema_migrations`).get()).toEqual({ version: 18 })
      db.exec('DROP TRIGGER prevent_attention_marker')
      expect(runMigrations(db)).toBe(1)
      expect(db.prepare('SELECT COUNT(*) AS count FROM run_attentions').get()).toEqual({ count: 1 })
    } finally { db.close() }
  })
})
