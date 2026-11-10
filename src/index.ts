import { Client, Events, GatewayIntentBits } from 'discord.js'

import { Agent } from 'undici'

import config from './config.js'
import { registerEvents } from './events/index.js'
import { DatabaseService } from './services/database.service.js'
import { PlayerService } from './services/player.service.js'
import { logger } from './utils/logger.js'
import { describeVersion } from './version.js'

// Первой строкой лога: по ней видно, обновился ли бот после деплоя
logger.info(`Запуск бота: ${describeVersion()}`)

const db = DatabaseService.getInstance()
const playerService = PlayerService.getInstance()

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

registerEvents(client)

// Без этих обработчиков любая необработанная ошибка в обработчике событий завершает процесс
client.on(Events.Error, error => {
  logger.error('Ошибка клиента Discord', error)
})

process.on('unhandledRejection', reason => {
  logger.error('Необработанная ошибка', reason)
})

client
  .login(config.token)
  .then(() => logger.info('Логин по токену успешен'))
  .catch(error => {
    logger.error('Не удалось войти в Discord', error)
    process.exit(1)
  })

let isShuttingDown = false

async function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) return
  isShuttingDown = true

  logger.info(`Получен сигнал ${signal}, останавливаем плееры и закрываем соединение с базой данных...`)

  try {
    await playerService.destroyAll('Бот перезапускается.')
    await client.destroy()
  } catch (error) {
    logger.error('Ошибка при завершении работы', error)
  } finally {
    db.close()
    process.exit(0)
  }
}

process.on('SIGINT', signal => void shutdown(signal))
process.on('SIGTERM', signal => void shutdown(signal))
