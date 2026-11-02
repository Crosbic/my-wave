import 'dotenv/config'

interface Config {
  token: string
  clientId: string
  admins: string[]
}

const config: Config = {
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.CLIENT_ID || '',
  admins: process.env.ADMINS
    ? process.env.ADMINS.split(',')
        .map(id => id.trim())
        .filter(Boolean)
    : []
}

if (!config.token) {
  throw new Error('DISCORD_TOKEN отсутствует в .env файле')
}

if (!config.clientId) {
  throw new Error('CLIENT_ID отсутствует в .env файле')
}

export default config
