import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { coreMigrations, runMigrations, type Migration } from '../src/migrations.js'
import { captureDraftTestV14Rows, draftTestV14Ids as ids, populateDraftTestV14Fixture } from './fixtures/draft-test-v14.js'

const legacyMigrations = coreMigrations.filter(migration => migration.version <= 17)
const admissionMigrations = coreMigrations.filter(migration => migration.version <= 18)
const admissionMigration = coreMigrations.find(migration => migration.version === 18)!

function populateLegacy(database: Database.Database): void {
  populateDraftTestV14Fixture(database)
  runMigrations(database, legacyMigrations)
}

function schema(database: Database.Database): unknown[] {
  return database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all()
}

function insertRun(database: Database.Database, id: string): void {
  database.prepare(`
    INSERT INTO runs (id, automation_id, revision_id, status, trigger_json, input_json, created_at)
    VALUES (?, ?, ?, 'QUEUED', '{}', '{}', '2026-10-18T10:00:00.000Z')
  `).run(id, ids.automation, ids.revision1)
}

function insertAdmission(database: Database.Database, runId: string, overrides: Record<string, unknown> = {}): number {
  const row = { run_id: runId, max_active: 1, overflow: 'queue', namespace: 'formal', ...overrides }
  const columns = Object.keys(row)
  return Number(database.prepare(`INSERT INTO run_admissions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...Object.values(row)).lastInsertRowid)
}

describe('durable Run admission migration', () => {
  it('preserves populated v17 history and leaves policy backfill to the Scheduler', () => {
    const database = new Database(':memory:')
    try {
      populateLegacy(database)
      const before = captureDraftTestV14Rows(database)
      const foreignKeys = database.pragma('foreign_key_list(runs)')
      const indexes = database.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' ORDER BY name").all()
      expect(runMigrations(database, admissionMigrations)).toBe(1)
      const after = captureDraftTestV14Rows(database)
      expect(after.run_admissions).toEqual([])
      delete after.run_admissions
      after.schema_migrations = after.schema_migrations!.filter(row => (row as { version: number }).version <= 17)
      expect(after).toEqual(before)
      expect(database.pragma('foreign_key_list(runs)')).toEqual(foreignKeys)
      const newIndexes = database.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' ORDER BY name").all()
      expect(newIndexes).toEqual(expect.arrayContaining(indexes))
      expect(database.pragma('index_info(runs_admission_group_idx)')).toMatchObject([
        { name: 'automation_id' }, { name: 'group_key' }, { name: 'status' },
      ])
      expect(database.pragma('foreign_key_check')).toEqual([])
      expect(database.pragma('integrity_check', { simple: true })).toBe('ok')
      const unchanged = captureDraftTestV14Rows(database)
      expect(() => runMigrations(database, legacyMigrations)).toThrow('unsupported database schema version 18')
      expect(captureDraftTestV14Rows(database)).toEqual(unchanged)
      expect(runMigrations(database, admissionMigrations)).toBe(0)
    } finally { database.close() }
  })

  it('retains FIFO sequence across deletion and VACUUM and does not reuse a removed tail', () => {
    const database = new Database(':memory:')
    try {
      populateLegacy(database)
      runMigrations(database, admissionMigrations)
      for (const id of ['run_z', 'run_a', 'run_m']) insertRun(database, id)
      expect(insertAdmission(database, 'run_z')).toBe(1)
      expect(insertAdmission(database, 'run_a')).toBe(2)
      expect(insertAdmission(database, 'run_m')).toBe(3)
      database.prepare('DELETE FROM runs WHERE id = ?').run('run_a')
      database.exec('VACUUM')
      expect(database.prepare('SELECT sequence, run_id, replacement_requested FROM run_admissions ORDER BY sequence').all())
        .toEqual([
          { sequence: 1, run_id: 'run_z', replacement_requested: 0 },
          { sequence: 3, run_id: 'run_m', replacement_requested: 0 },
        ])
      database.prepare('DELETE FROM runs WHERE id = ?').run('run_m')
      insertRun(database, 'run_next')
      expect(insertAdmission(database, 'run_next')).toBe(4)
      expect(database.prepare('SELECT run_id FROM run_admissions ORDER BY sequence').pluck().all()).toEqual(['run_z', 'run_next'])
      expect(database.pragma('foreign_key_check')).toEqual([])
    } finally { database.close() }
  })

  it('enforces policy domains, unique Run identity and foreign keys on writes', () => {
    const database = new Database(':memory:')
    try {
      populateLegacy(database)
      runMigrations(database, admissionMigrations)
      insertRun(database, 'run_valid')
      insertAdmission(database, 'run_valid')
      const invalid = [
        { max_active: 0 }, { max_active: -1 }, { max_active: 1.5 }, { max_active: 'invalid' },
        { max_active: 9007199254740992 },
        { overflow: 'unknown' }, { overflow: null },
        { namespace: 'unknown' }, { namespace: null },
        { replacement_requested: -1 }, { replacement_requested: 2 }, { replacement_requested: 0.5 },
        { replacement_requested: null },
      ]
      invalid.forEach((overrides, index) => {
        const runId = `run_invalid_${index}`
        insertRun(database, runId)
        expect(() => insertAdmission(database, runId, overrides)).toThrow(/CHECK|NOT NULL/)
        const [column, value] = Object.entries(overrides)[0]!
        expect(() => database.prepare(`UPDATE run_admissions SET ${column} = ? WHERE run_id = ?`).run(value, 'run_valid')).toThrow(/CHECK|NOT NULL/)
      })
      expect(() => insertAdmission(database, 'run_valid')).toThrow(/UNIQUE/)
      expect(() => insertAdmission(database, 'run_missing')).toThrow(/FOREIGN KEY/)
      expect(database.prepare('SELECT COUNT(*) AS count FROM run_admissions').get()).toEqual({ count: 1 })
      for (const [index, overrides] of [
        { max_active: null, overflow: 'queue', namespace: 'formal' },
        { max_active: 9007199254740991, overflow: 'drop', namespace: 'test' },
        { max_active: 2, overflow: 'replace', namespace: 'formal', replacement_requested: 1 },
      ].entries()) {
        insertRun(database, `run_allowed_${index}`)
        insertAdmission(database, `run_allowed_${index}`, overrides)
      }
      expect(database.prepare('SELECT COUNT(*) AS count FROM run_admissions').get()).toEqual({ count: 4 })
    } finally { database.close() }
  })

  it('rolls back a Run and its admission together when acceptance fails', () => {
    const database = new Database(':memory:')
    try {
      populateLegacy(database)
      runMigrations(database, admissionMigrations)
      const before = captureDraftTestV14Rows(database)
      expect(() => database.transaction(() => {
        insertRun(database, 'run_atomic')
        insertAdmission(database, 'run_atomic', { overflow: 'replace', replacement_requested: 1 })
        throw new Error('acceptance failed')
      }).immediate()).toThrow('acceptance failed')
      expect(captureDraftTestV14Rows(database)).toEqual(before)
      expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'run_admissions'").get()).toBeUndefined()
    } finally { database.close() }
  })

  it.each(['after-ddl', 'marker'] as const)('rolls back migration schema and legacy data after %s failure, then retries', failure => {
    const database = new Database(':memory:')
    try {
      populateLegacy(database)
      if (failure === 'marker') database.exec("CREATE TRIGGER fail_admission_marker BEFORE INSERT ON schema_migrations WHEN NEW.version = 18 BEGIN SELECT RAISE(ABORT, 'marker failure'); END;")
      const before = captureDraftTestV14Rows(database)
      const beforeSchema = schema(database)
      const injectedMigration: Migration = { ...admissionMigration, up(db) {
        admissionMigration.up(db)
        if (failure === 'after-ddl') throw new Error('injected migration failure')
      } }
      expect(() => runMigrations(database, [...legacyMigrations, injectedMigration])).toThrow(/migration failure|marker failure/)
      expect(captureDraftTestV14Rows(database)).toEqual(before)
      expect(schema(database)).toEqual(beforeSchema)
      if (failure === 'marker') database.exec('DROP TRIGGER fail_admission_marker')
      expect(runMigrations(database, admissionMigrations)).toBe(1)
      expect(runMigrations(database, admissionMigrations)).toBe(0)
      expect(database.pragma('foreign_key_check')).toEqual([])
    } finally { database.close() }
  })
})
