import { Client, Events, GatewayIntentBits, RESTEvents } from 'discord.js'

import { Agent } from 'undici'

import config from './config.js'
import { registerEvents } from './events/index.js'
import { DatabaseService } from './services/database.service.js'
import { PlayerService } from './services/player.service.js'
import { logger } from './utils/logger.js'
import { describeVersion } from './version.js'

// Если завершение работы зависнет, процесс всё равно выйдет через столько миллисекунд
const FORCE_EXIT_TIMEOUT = 10_000
// Короткие ожидания из-за ограничений Discord на частоту запросов — обычное дело. Предупреждением в лог идут
// только глобальные ограничения и ожидания от стольких миллисекунд
const LONG_RATE_LIMIT = 5_000

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

let isShuttingDown = false

registerEvents(client)
watchDiscordConnection(client)

// Без этого обработчика необработанная ошибка в промисе завершила бы процесс
process.on('unhandledRejection', reason => {
  logger.error('Необработанная ошибка в промисе', reason)
})

// После необработанного исключения состояние процесса не гарантировано: бот останавливает плееры и завершается
// с кодом 1, а Docker перезапускает контейнер
process.on('uncaughtException', error => {
  logger.error('Необработанное исключение, бот перезапускается', error)
  void shutdown(1)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info(`Получен сигнал ${signal}, останавливаем плееры и закрываем соединение с базой данных...`)
    void shutdown(0)
  })
}

client
  .login(config.token)
  .then(() => logger.info('Логин по токену успешен'))
  .catch(error => {
    logger.error('Не удалось войти в Discord', error)
    process.exit(1)
  })

/**
 * Остановка плееров и закрытие соединений. Код 1 — завершение из-за сбоя: Docker перезапустит контейнер
 */
async function shutdown(exitCode: number) {
  if (isShuttingDown) return
  isShuttingDown = true
  setTimeout(() => process.exit(exitCode), FORCE_EXIT_TIMEOUT).unref()

  try {
    await playerService.destroyAll('Бот перезапускается.')
    await client.destroy()
  } catch (error) {
    logger.error('Ошибка при завершении работы', error)
  } finally {
    db.close()
    process.exit(exitCode)
  }
}

/**
 * Связь бота с Discord в логе: обрывы и восстановление шлюза, ошибки и ограничения запросов.
 * Если Discord закрыл соединение без права переподключиться (например, токен бота сброшен),
 * бот завершается с ошибкой: живой процесс без связи с Discord со стороны выглядел бы рабочим
 */
function watchDiscordConnection(client: Client): void {
  // При остановке бот сам закрывает соединение, это не обрыв
  const active = () => !isShuttingDown

  client.on(Events.Error, error => logger.error('Ошибка клиента Discord', error))
  client.on(Events.Warn, message => logger.warn(`Discord: ${message}`))

  client.on(Events.ShardReady, shardId => {
    logger.info(`Шлюз Discord: подключение установлено (шард ${shardId})`)
  })
  client.on(Events.ShardReconnecting, shardId => {
    if (active()) logger.info(`Шлюз Discord: соединение прервано, переподключаемся (шард ${shardId})`)
  })
  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    logger.info(`Шлюз Discord: соединение восстановлено (шард ${shardId}, пропущенных событий: ${replayedEvents})`)
  })
  client.on(Events.ShardError, (error, shardId) => {
    if (active()) logger.warn(`Шлюз Discord: ошибка соединения (шард ${shardId})`, error)
  })
  client.on(Events.ShardDisconnect, (event, shardId) => {
    if (!active()) return
    logger.error(
      `Шлюз Discord закрыл соединение без переподключения (шард ${shardId}, код ${event.code}), бот перезапускается`
    )
    void shutdown(1)
  })

  client.rest.on(RESTEvents.RateLimited, info => {
    const level = info.global || info.retryAfter >= LONG_RATE_LIMIT ? 'warn' : 'debug'
    // route без токенов: в адресе вебхука взаимодействия токен заменён на :token
    logger[level](
      `Discord ограничил запросы${info.global ? ' глобально' : ''}: ${info.method} ${info.route}, ожидание ${info.retryAfter} мс`
    )
  })
}
