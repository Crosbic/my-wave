import 'dotenv/config'

interface Config {
  token: string
  clientId: string
  admins: string[]
  encryptionKey: string
  dataDir?: string
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
  dataDir: process.env.DATA_DIR || undefined
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

export default config
