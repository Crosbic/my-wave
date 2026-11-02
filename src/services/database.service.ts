import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import Database from 'better-sqlite3'

import config from '../config.js'
import { IUserData } from '../types/userData.js'
import { decrypt, encrypt, isEncrypted } from '../utils/crypto.js'
import { describeError } from '../utils/errors.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_FILE = 'data.db'
// Так база называлась в версиях из ветки master до слияния с dev: при старте её данные переносятся в data.db
const LEGACY_DB_FILE = 'users.db'

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

export class DatabaseService {
  private static instance: DatabaseService
  private db: Database.Database

  private constructor() {
    const dbDir = config.dataDir ? path.resolve(config.dataDir) : path.join(__dirname, '../../data')
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }

    const dbPath = path.join(dbDir, DB_FILE)
    const isNewDatabase = !fs.existsSync(dbPath)
    this.db = new Database(dbPath)

    this.db.pragma('foreign_keys = ON')
    this.createTables()

    const legacyPath = path.join(dbDir, LEGACY_DB_FILE)
    const migrated = fs.existsSync(legacyPath) && this.migrateLegacyDatabase(legacyPath)
    this.encryptPlainTokens()

    console.log(`База данных: ${dbPath}, пользователей: ${this.userCount}`)
    if (isNewDatabase && !migrated) {
      // Частая причина — контейнер пересоздан без постоянного хранилища для каталога базы
      console.warn(
        'База данных создана заново. Если бот уже работал раньше, данные не сохранились между перезапусками: ' +
          'подключите каталог базы как постоянное хранилище (volume) или укажите путь к нему в DATA_DIR.'
      )
    }
  }

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService()
    }
    return DatabaseService.instance
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
      console.error(
        `Не удалось расшифровать токен пользователя ${discordId}: проверьте, что ENCRYPTION_KEY не менялся.`,
        describeError(error)
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

  private createTables(): void {
    this.db.exec(`
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        public_buttons_access BOOLEAN NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  }

  /**
   * Перенос данных из users.db в data.db. Если пользователь есть в обеих базах, остаётся более свежая запись.
   * Токены при переносе шифруются, а старый файл переименовывается и остаётся как резервная копия
   */
  private migrateLegacyDatabase(legacyPath: string): boolean {
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
      console.error(`Не удалось прочитать ${LEGACY_DB_FILE}, перенос пропущен:`, describeError(error))
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

    let migratedUsers = 0
    let migratedSettings = 0
    this.db.transaction(() => {
      for (const user of users) {
        const accessToken = isEncrypted(user.access_token) ? user.access_token : encrypt(user.access_token)
        migratedUsers += upsertUser.run({ ...user, access_token: accessToken }).changes
      }
      for (const setting of settings) {
        migratedSettings += upsertSettings.run(setting).changes
      }
    })()

    const backupPath = `${legacyPath}.migrated-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      fs.renameSync(legacyPath, backupPath)
    } catch (error) {
      console.error(`Не удалось переименовать ${LEGACY_DB_FILE} после переноса:`, describeError(error))
    }

    console.log(
      `Перенос из ${LEGACY_DB_FILE}: пользователей ${migratedUsers} из ${users.length}, ` +
        `настроек серверов ${migratedSettings} из ${settings.length}. Старый файл: ${path.basename(backupPath)}`
    )
    return true
  }

  /**
   * Шифрование токенов, сохранённых до появления шифрования
   */
  private encryptPlainTokens(): void {
    const rows = this.db.prepare('SELECT discord_id, access_token FROM users').all() as Pick<
      UserRow,
      'discord_id' | 'access_token'
    >[]
    const plain = rows.filter(row => !isEncrypted(row.access_token))
    if (plain.length === 0) {
      return
    }

    const update = this.db.prepare('UPDATE users SET access_token = ? WHERE discord_id = ?')
    this.db.transaction(() => {
      for (const row of plain) {
        update.run(encrypt(row.access_token), row.discord_id)
      }
    })()
    console.log(`Зашифровано токенов, сохранённых без шифрования: ${plain.length}`)
  }
}
