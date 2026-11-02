import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { Client, Collection, Events, GatewayIntentBits } from 'discord.js'

import { Agent } from 'undici'

import config from './config.js'
import { DatabaseService } from './services/database.service.js'
import { PlayerService } from './services/player.service.js'
import { describeError } from './utils/errors.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const db = DatabaseService.getInstance()
const playerService = PlayerService.getInstance()

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, any>
  }
}

const agent = new Agent({
  connect: {
    timeout: 60_000
  }
})

// Боту нужны только серверы и голосовые состояния, привилегированные интенты не требуются
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  rest: {
    timeout: 60_000,
    agent
  }
})

client.commands = new Collection()

const commandsPath = path.join(__dirname, 'commands')
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'))

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file)
  const command = await import(`file://${filePath}`)

  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command)
  } else {
    console.log(`[ПРЕДУПРЕЖДЕНИЕ] Команда в ${filePath} отсутствует обязательное свойство "data" или "execute".`)
  }
}

const eventsPath = path.join(__dirname, 'events')
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'))

for (const file of eventFiles) {
  const filePath = path.join(eventsPath, file)
  const event = await import(`file://${filePath}`)

  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args))
  } else {
    client.on(event.name, (...args) => event.execute(...args))
  }
}

// Без этих обработчиков любая необработанная ошибка в обработчике событий завершает процесс
client.on(Events.Error, error => {
  console.error('Ошибка клиента Discord:', describeError(error))
})

process.on('unhandledRejection', reason => {
  console.error('Необработанная ошибка:', describeError(reason))
})

client
  .login(config.token)
  .then(() => console.log('Логин по токену успешен'))
  .catch(error => {
    console.error('Не удалось войти в Discord:', describeError(error))
    process.exit(1)
  })

let isShuttingDown = false

async function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`Получен сигнал ${signal}, останавливаем плееры и закрываем соединение с базой данных...`)

  try {
    await playerService.destroyAll('Бот перезапускается.')
    await client.destroy()
  } catch (error) {
    console.error('Ошибка при завершении работы:', describeError(error))
  } finally {
    db.close()
    process.exit(0)
  }
}

process.on('SIGINT', signal => void shutdown(signal))
process.on('SIGTERM', signal => void shutdown(signal))
