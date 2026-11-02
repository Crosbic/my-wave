import 'dotenv/config'

// silent отключает логи полностью, например в тестах
const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

interface Config {
  token: string
  clientId: string
  admins: string[]
  encryptionKey: string
  dataDir?: string
  logLevel: LogLevel
}

const config: Config = {
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.CLIENT_ID || '',
  admins: process.env.ADMINS
    ? process.env.ADMINS.split(',')
        .map(id => id.trim())
        .filter(Boolean)
    : [],
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  // Каталог базы пользователей. Если не задан — data/ в корне проекта (в Docker это /app/data)
  dataDir: process.env.DATA_DIR || undefined,
  logLevel: resolveLogLevel()
}

if (!config.token) {
  throw new Error('DISCORD_TOKEN отсутствует в .env файле')
}

if (!config.clientId) {
  throw new Error('CLIENT_ID отсутствует в .env файле')
}

if (!config.encryptionKey) {
  throw new Error('ENCRYPTION_KEY отсутствует в .env файле (используется для шифрования токенов в БД)')
}

/**
 * Уровень логов: LOG_LEVEL, а если он не задан — debug при DEBUG=true и info в остальных случаях
 */
function resolveLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.trim().toLowerCase()
  if (!level) {
    return process.env.DEBUG?.trim().toLowerCase() === 'true' ? 'debug' : 'info'
  }

  if ((LOG_LEVELS as readonly string[]).includes(level)) {
    return level as LogLevel
  }

  console.warn(`Неизвестный LOG_LEVEL "${process.env.LOG_LEVEL}", используется info`)
  return 'info'
}

export default config
