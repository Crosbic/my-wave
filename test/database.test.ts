import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { after, describe, it } from 'node:test'
import path from 'path'

import Database from 'better-sqlite3'

import { removeDir, tempDir } from './helpers.js'
import { DatabaseService } from '../src/services/database.service.js'
import { encrypt, isEncrypted } from '../src/utils/crypto.js'

const LATEST_SCHEMA_VERSION = 3
const dirs: string[] = []

after(() => dirs.forEach(removeDir))

function newDir(name: string): string {
  const dir = tempDir(name)
  dirs.push(dir)
  return dir
}

const SCHEMA = `
  CREATE TABLE users (
    discord_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, yandex_id TEXT NOT NULL,
    full_name TEXT, first_name TEXT, last_name TEXT, nick_name TEXT, avatar_url TEXT,
    has_plus BOOLEAN NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY, public_buttons_access BOOLEAN NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );`

/**
 * База в старом формате, как её оставили прошлые версии бота (user_version = 0)
 */
function seedDatabase(file: string, users: [string, string, string][], settings: [string, number, string][] = []) {
  const db = new Database(file)
  db.exec(SCHEMA)
  const insertUser = db.prepare(
    'INSERT INTO users (discord_id, access_token, yandex_id, nick_name, has_plus, updated_at) VALUES (?, ?, ?, ?, 1, ?)'
  )
  for (const [id, token, updatedAt] of users) {
    insertUser.run(id, token, `yandex-${id}`, id, updatedAt)
  }
  const insertSetting = db.prepare(
    'INSERT INTO guild_settings (guild_id, public_buttons_access, updated_at) VALUES (?, ?, ?)'
  )
  for (const setting of settings) {
    insertSetting.run(...setting)
  }
  db.close()
}

function storedTokens(dir: string): string[] {
  const db = new Database(path.join(dir, 'data.db'), { readonly: true })
  const tokens = (db.prepare('SELECT access_token FROM users').all() as { access_token: string }[]).map(
    row => row.access_token
  )
  db.close()
  return tokens
}

const userInfo = {
  id: 'yandex-1',
  fullName: 'Full',
  firstName: 'First',
  lastName: 'Last',
  nickName: 'Nick',
  avatarUrl: '',
  hasPlus: true
}

describe('DatabaseService', () => {
  it('новая база создаётся сразу с последней версией схемы и без резервных копий', () => {
    const dir = newDir('db-new')
    const db = DatabaseService.open(dir)

    assert.equal(db.schemaVersion, LATEST_SCHEMA_VERSION)
    db.saveUserToken('user', 'plain-token', userInfo)
    assert.equal(db.getUserData('user')?.accessToken, 'plain-token')
    db.setPublicButtonsAccess('guild', true)
    assert.equal(db.getPublicButtonsAccess('guild'), true)
    db.close()

    assert.ok(storedTokens(dir).every(isEncrypted), 'токены хранятся зашифрованными')
    assert.deepEqual(fs.readdirSync(dir), ['data.db'])
  })

  it('старая база мигрирует с резервной копией, незашифрованные токены шифруются', () => {
    const dir = newDir('db-migrate')
    seedDatabase(path.join(dir, 'data.db'), [
      ['encrypted', encrypt('token-a'), '2026-07-21 10:00:00'],
      ['plain', 'token-b', '2026-07-01 10:00:00']
    ])

    const db = DatabaseService.open(dir)
    assert.equal(db.schemaVersion, LATEST_SCHEMA_VERSION)
    assert.equal(db.getUserData('encrypted')?.accessToken, 'token-a')
    assert.equal(db.getUserData('plain')?.accessToken, 'token-b')
    db.close()

    assert.ok(storedTokens(dir).every(isEncrypted))
    const backups = fs.readdirSync(dir).filter(name => name.startsWith('data.db.backup-v0-'))
    assert.equal(backups.length, 1)

    const backup = new Database(path.join(dir, backups[0]), { readonly: true })
    assert.equal(backup.pragma('user_version', { simple: true }), 0, 'копия сделана до миграции')
    backup.close()
  })

  it('хранит только три последние резервные копии', () => {
    const dir = newDir('db-backups')
    seedDatabase(path.join(dir, 'data.db'), [])
    for (const [index, name] of ['a', 'b', 'c'].entries()) {
      const file = path.join(dir, `data.db.backup-v0-old-${name}`)
      fs.writeFileSync(file, '')
      const time = new Date(Date.now() - (10 - index) * 60_000)
      fs.utimesSync(file, time, time)
    }

    DatabaseService.open(dir).close()

    const backups = fs.readdirSync(dir).filter(name => name.startsWith('data.db.backup-'))
    assert.equal(backups.length, 3)
    assert.ok(!backups.includes('data.db.backup-v0-old-a'), 'самая старая копия удалена')
  })

  it('переносит users.db: из двух записей остаётся более свежая', () => {
    const dir = newDir('db-legacy')
    seedDatabase(
      path.join(dir, 'data.db'),
      [
        ['alice', encrypt('alice-old'), '2026-07-21 10:00:00'],
        ['bob', encrypt('bob-token'), '2026-07-21 10:00:00']
      ],
      [['guild-1', 1, '2026-07-21 10:00:00']]
    )
    seedDatabase(
      path.join(dir, 'users.db'),
      [
        ['alice', 'alice-new', '2026-11-02 12:00:00'],
        ['carol', 'carol-token', '2026-11-02 12:30:00']
      ],
      [
        ['guild-1', 0, '2026-06-01 10:00:00'],
        ['guild-2', 1, '2026-11-02 12:00:00']
      ]
    )

    const db = DatabaseService.open(dir)
    assert.equal(db.userCount, 3)
    assert.equal(db.getUserData('alice')?.accessToken, 'alice-new')
    assert.equal(db.getUserData('bob')?.accessToken, 'bob-token')
    assert.equal(db.getUserData('carol')?.accessToken, 'carol-token')
    assert.equal(db.getPublicButtonsAccess('guild-1'), true, 'более свежая настройка из data.db')
    assert.equal(db.getPublicButtonsAccess('guild-2'), true)
    db.close()

    const files = fs.readdirSync(dir)
    assert.ok(!files.includes('users.db'))
    assert.ok(files.some(name => name.startsWith('users.db.migrated-')))
    assert.ok(storedTokens(dir).every(isEncrypted))
  })

  it('запоминает настройки волны, а повреждённую запись читает как «Любое»', () => {
    const dir = newDir('db-wave-choice')
    const choice = {
      activity: { seed: 'activity:workout', name: 'Тренируюсь' },
      language: { seed: 'settingLanguage:russian', name: 'Русский' }
    }

    const db = DatabaseService.open(dir)
    assert.deepEqual(db.getWaveChoice('user'), {}, 'без сохранённого выбора всё «Любое»')
    db.saveWaveChoice('user', choice)
    assert.deepEqual(db.getWaveChoice('user'), choice)
    db.saveWaveChoice('other', {})
    assert.deepEqual(db.getWaveChoice('other'), {})
    db.close()

    const raw = new Database(path.join(dir, 'data.db'))
    const insert = raw.prepare('INSERT INTO wave_settings (discord_id, choice) VALUES (?, ?)')
    insert.run('broken', '{not json')
    insert.run(
      'partial',
      JSON.stringify({
        moodEnergy: { seed: 'settingMoodEnergy:fun', name: 'Весёлое' },
        language: { seed: 1 },
        unknown: { seed: 'x', name: 'y' }
      })
    )
    raw.close()

    const reopened = DatabaseService.open(dir)
    assert.deepEqual(reopened.getWaveChoice('broken'), {})
    assert.deepEqual(reopened.getWaveChoice('partial'), {
      moodEnergy: { seed: 'settingMoodEnergy:fun', name: 'Весёлое' }
    })
    assert.deepEqual(reopened.getWaveChoice('user'), choice, 'выбор пережил перезапуск')
    reopened.close()
  })

  it('токен, зашифрованный другим ключом, считается отсутствующим, но не удаляется', () => {
    const dir = newDir('db-wrong-key')
    const db = DatabaseService.open(dir)
    db.saveUserToken('user', 'token', userInfo)
    db.close()

    // Тот же формат, что у utils/crypto, но с другим ключом
    const otherKey = crypto.scryptSync('other-key', 'ym-player-bot:token-salt', 32)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', otherKey, iv)
    const encrypted = Buffer.concat([cipher.update('token', 'utf8'), cipher.final()])
    const foreignToken = `enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`
    const raw = new Database(path.join(dir, 'data.db'))
    raw.prepare('UPDATE users SET access_token = ?').run(foreignToken)
    raw.close()

    const reopened = DatabaseService.open(dir)
    assert.equal(reopened.getUserData('user'), undefined)
    assert.equal(reopened.hasUserToken('user'), true)
    reopened.close()
  })
})
