import { REST, Routes } from 'discord.js'

import { commands } from './commands/index.js'
import config from './config.js'
import { logger } from './utils/logger.js'

// Ручная регистрация команд. Обычно не нужна: бот синхронизирует команды при каждом запуске
const body = commands.map(command => command.data.toJSON())
const rest = new REST().setToken(config.token)

try {
  logger.info(`Регистрация слеш-команд: ${body.length}`)
  await rest.put(Routes.applicationCommands(config.clientId), { body })
  logger.info('Слеш-команды зарегистрированы')
} catch (error) {
  logger.error('Не удалось зарегистрировать слеш-команды', error)
  process.exitCode = 1
}
