import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import Database from 'better-sqlite3'

import config from '../config.js'
import { IUserData } from '../types/userData.js'
import { decrypt, encrypt, isEncrypted } from '../utils/crypto.js'
import { logger } from '../utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_FILE = 'data.db'
// Так база называлась в версиях из ветки master до слияния с dev: при старте её данные переносятся в data.db
const LEGACY_DB_FILE = 'users.db'
const BACKUPS_TO_KEEP = 3

const log = logger.child('db')

interface UserRow {
  discord_id: string
  access_token: string
  yandex_id: string
  full_name: string | null
  first_name: string | null
  last_name: string | null
  nick_name: string | null
  avatar_url: string | null
  has_plus: number
  created_at: string | null
  updated_at: string | null
}

interface GuildSettingsRow {
  guild_id: string
  public_buttons_access: number
  updated_at: string | null
}

interface Migration {
  version: number
  description: string
  up(db: Database.Database): void
}

/**
 * Миграции схемы по порядку. Номер последней применённой хранится в PRAGMA user_version.
 * Новую миграцию добавляйте в конец со следующим номером, уже выпущенные не меняйте.
 * Перед миграцией существующей базы делается резервная копия
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'таблицы пользователей и настроек серверов',
    up: db => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          discord_id TEXT PRIMARY KEY,
          access_token TEXT NOT NULL,
          yandex_id TEXT NOT NULL,
          full_name TEXT,
          first_name TEXT,
          last_name TEXT,
          nick_name TEXT,
          avatar_url TEXT,
          has_plus BOOLEAN NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS guild_settings (
          guild_id TEXT PRIMARY KEY,
          public_buttons_access BOOLEAN NOT NULL DEFAULT 0,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)
    }
  },
  {
    version: 2,
    description: 'шифрование токенов, сохранённых без шифрования',
    up: db => {
      const rows = db.prepare('SELECT discord_id, access_token FROM users').all() as Pick<
        UserRow,
        'discord_id' | 'access_token'
      >[]
      const update = db.prepare('UPDATE users SET access_token = ? WHERE discord_id = ?')

      for (const row of rows) {
        if (!isEncrypted(row.access_token)) {
          update.run(encrypt(row.access_token), row.discord_id)
        }
      }
    }
  }
]

export class DatabaseService {
  private static instance: DatabaseService
  private db: Database.Database

  private constructor(dbDir: string) {
    fs.mkdirSync(dbDir, { recursive: true })

    const dbPath = path.join(dbDir, DB_FILE)
    const isNewDatabase = !fs.existsSync(dbPath)
    this.db = new Database(dbPath)

    this.db.pragma('foreign_keys = ON')
    this.migrate(dbPath, isNewDatabase)

    const legacyPath = path.join(dbDir, LEGACY_DB_FILE)
    const imported = fs.existsSync(legacyPath) && this.importLegacyDatabase(legacyPath)

    log.info(`База данных: ${dbPath}, пользователей: ${this.userCount}`)
    if (isNewDatabase && !imported) {
      // Частая причина — контейнер пересоздан без постоянного хранилища для каталога базы
      log.warn(
        'База данных создана заново. Если бот уже работал раньше, данные не сохранились между перезапусками: ' +
          'подключите каталог базы как постоянное хранилище (volume) или укажите путь к нему в DATA_DIR.'
      )
    }
  }

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      const dbDir = config.dataDir ? path.resolve(config.dataDir) : path.join(__dirname, '../../data')
      DatabaseService.instance = new DatabaseService(dbDir)
    }
    return DatabaseService.instance
  }

  /**
   * Отдельная база в указанном каталоге, без общего экземпляра: для тестов и обслуживания
   */
  static open(dbDir: string): DatabaseService {
    return new DatabaseService(dbDir)
  }

  get schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number
  }

  saveUserToken(discordId: string, accessToken: string, userInfo: IUserData): void {
    const stmt = this.db.prepare(`
      INSERT INTO users (
        discord_id, access_token, yandex_id, full_name, first_name, last_name,
        nick_name, avatar_url, has_plus, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(discord_id) DO UPDATE SET
        access_token = excluded.access_token,
        yandex_id = excluded.yandex_id,
        full_name = excluded.full_name,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        nick_name = excluded.nick_name,
        avatar_url = excluded.avatar_url,
        has_plus = excluded.has_plus,
        updated_at = CURRENT_TIMESTAMP
    `)

    stmt.run(
      discordId,
      encrypt(accessToken),
      userInfo.id,
      userInfo.fullName,
      userInfo.firstName,
      userInfo.lastName,
      userInfo.nickName,
      userInfo.avatarUrl,
      userInfo.hasPlus ? 1 : 0
    )
  }

  hasUserToken(discordId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM users WHERE discord_id = ?')
    const result = stmt.get(discordId)
    return !!result
  }

  removeUserToken(discordId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM users WHERE discord_id = ?')
    const result = stmt.run(discordId)
    return result.changes > 0
  }

  getUserData(discordId: string): { accessToken: string; userInfo: IUserData } | undefined {
    const stmt = this.db.prepare(`
      SELECT
        access_token, yandex_id, full_name, first_name, last_name,
        nick_name, avatar_url, has_plus
      FROM users
      WHERE discord_id = ?
    `)

    const row = stmt.get(discordId) as UserRow | undefined

    if (!row) {
      return undefined
    }

    let accessToken: string
    try {
      accessToken = decrypt(row.access_token)
    } catch (error) {
      // Пользователь сможет заново выполнить /login, и токен перезапишется
      log.error(
        `Не удалось расшифровать токен пользователя ${discordId}: проверьте, что ENCRYPTION_KEY не менялся`,
        error
      )
      return undefined
    }

    return {
      accessToken,
      userInfo: {
        id: row.yandex_id,
        fullName: row.full_name ?? '',
        firstName: row.first_name ?? '',
        lastName: row.last_name ?? '',
        nickName: row.nick_name ?? '',
        avatarUrl: row.avatar_url ?? '',
        hasPlus: !!row.has_plus
      }
    }
  }

  getPublicButtonsAccess(guildId: string): boolean {
    const stmt = this.db.prepare('SELECT public_buttons_access FROM guild_settings WHERE guild_id = ?')
    const row = stmt.get(guildId) as { public_buttons_access: number } | undefined
    return !!row?.public_buttons_access
  }

  setPublicButtonsAccess(guildId: string, enabled: boolean): void {
    const stmt = this.db.prepare(`
      INSERT INTO guild_settings (guild_id, public_buttons_access, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET
        public_buttons_access = excluded.public_buttons_access,
        updated_at = CURRENT_TIMESTAMP
    `)

    stmt.run(guildId, enabled ? 1 : 0)
  }

  get userCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM users')
    const result = stmt.get() as { count: number }
    return result.count
  }

  close(): void {
    this.db.close()
  }

  private migrate(dbPath: string, isNewDatabase: boolean): void {
    const currentVersion = this.schemaVersion
    const latestVersion = MIGRATIONS[MIGRATIONS.length - 1].version

    if (currentVersion > latestVersion) {
      log.warn(
        `Схема базы (версия ${currentVersion}) новее, чем знает бот (${latestVersion}): похоже, запущена старая версия бота`
      )
      return
    }

    const pending = MIGRATIONS.filter(migration => migration.version > currentVersion)
    if (pending.length === 0) {
      return
    }

    if (!isNewDatabase) {
      this.backup(dbPath, currentVersion)
    }

    for (const migration of pending) {
      this.db.transaction(() => {
        migration.up(this.db)
        this.db.pragma(`user_version = ${migration.version}`)
      })()
      log.info(`Миграция базы до версии ${migration.version}: ${migration.description}`)
    }
  }

  /**
   * Резервная копия базы перед миграцией. Хранятся только последние BACKUPS_TO_KEEP копий
   */
  private backup(dbPath: string, version: number): void {
    const backupPath = `${dbPath}.backup-v${version}-${timestamp()}`
    try {
      this.db.prepare('VACUUM INTO ?').run(backupPath)
    } catch (error) {
      throw new Error('Не удалось сделать резервную копию базы перед миграцией', { cause: error })
    }
    log.info(`Резервная копия базы перед миграцией: ${path.basename(backupPath)}`)

    const dir = path.dirname(dbPath)
    const prefix = `${path.basename(dbPath)}.backup-`
    const backups = fs
      .readdirSync(dir)
      .filter(name => name.startsWith(prefix))
      .map(name => ({ name, modified: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => a.modified - b.modified)

    for (const old of backups.slice(0, -BACKUPS_TO_KEEP)) {
      fs.rmSync(path.join(dir, old.name), { force: true })
    }
  }

  /**
   * Перенос данных из users.db в data.db. Если пользователь есть в обеих базах, остаётся более свежая запись.
   * Токены при переносе шифруются, а старый файл переименовывается и остаётся как резервная копия
   */
  private importLegacyDatabase(legacyPath: string): boolean {
    let users: UserRow[]
    let settings: GuildSettingsRow[]

    try {
      const legacy = new Database(legacyPath, { readonly: true, fileMustExist: true })
      try {
        const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string
        }[]
        const tableNames = new Set(tables.map(table => table.name))
        users = tableNames.has('users') ? (legacy.prepare('SELECT * FROM users').all() as UserRow[]) : []
        settings = tableNames.has('guild_settings')
          ? (legacy.prepare('SELECT * FROM guild_settings').all() as GuildSettingsRow[])
          : []
      } finally {
        legacy.close()
      }
    } catch (error) {
      log.error(`Не удалось прочитать ${LEGACY_DB_FILE}, перенос пропущен`, error)
      return false
    }

    const upsertUser = this.db.prepare(`
      INSERT INTO users (
        discord_id, access_token, yandex_id, full_name, first_name, last_name,
        nick_name, avatar_url, has_plus, created_at, updated_at
      ) VALUES (
        @discord_id, @access_token, @yandex_id, @full_name, @first_name, @last_name,
        @nick_name, @avatar_url, @has_plus, COALESCE(@created_at, CURRENT_TIMESTAMP), COALESCE(@updated_at, CURRENT_TIMESTAMP)
      )
      ON CONFLICT(discord_id) DO UPDATE SET
        access_token = excluded.access_token,
        yandex_id = excluded.yandex_id,
        full_name = excluded.full_name,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        nick_name = excluded.nick_name,
        avatar_url = excluded.avatar_url,
        has_plus = excluded.has_plus,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at > COALESCE(users.updated_at, '')
    `)

    const upsertSettings = this.db.prepare(`
      INSERT INTO guild_settings (guild_id, public_buttons_access, updated_at)
      VALUES (@guild_id, @public_buttons_access, COALESCE(@updated_at, CURRENT_TIMESTAMP))
      ON CONFLICT(guild_id) DO UPDATE SET
        public_buttons_access = excluded.public_buttons_access,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at > COALESCE(guild_settings.updated_at, '')
    `)

    let importedUsers = 0
    let importedSettings = 0
    this.db.transaction(() => {
      for (const user of users) {
        const accessToken = isEncrypted(user.access_token) ? user.access_token : encrypt(user.access_token)
        importedUsers += upsertUser.run({ ...user, access_token: accessToken }).changes
      }
      for (const setting of settings) {
        importedSettings += upsertSettings.run(setting).changes
      }
    })()

    const backupPath = `${legacyPath}.migrated-${timestamp()}`
    try {
      fs.renameSync(legacyPath, backupPath)
    } catch (error) {
      log.error(`Не удалось переименовать ${LEGACY_DB_FILE} после переноса`, error)
    }

    log.info(
      `Перенос из ${LEGACY_DB_FILE}: пользователей ${importedUsers} из ${users.length}, ` +
        `настроек серверов ${importedSettings} из ${settings.length}. Старый файл: ${path.basename(backupPath)}`
    )
    return true
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
