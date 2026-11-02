import { ApplicationCommand, Client, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js'

import { logger } from '../utils/logger.js'

import { commands } from './index.js'

type ComparableCommand = Parameters<ApplicationCommand['equals']>[0]

/**
 * Регистрирует слеш-команды в Discord, если они отличаются от уже зарегистрированных.
 * Выполняется при каждом запуске бота, в том числе при каждом деплое
 */
export async function syncCommands(client: Client<true>): Promise<void> {
  const local = commands.map(command => command.data.toJSON())

  try {
    const registered = await client.application.commands.fetch()
    const upToDate =
      registered.size === local.length &&
      local.every(data => {
        const existing = registered.find(command => command.name === data.name)
        return existing ? existing.equals(comparable(data, existing)) : false
      })

    if (upToDate) {
      logger.info(`Слеш-команды актуальны: ${local.length}`)
      return
    }

    await client.application.commands.set(local)
    logger.info(`Слеш-команды обновлены: ${local.length}`)
  } catch (error) {
    logger.error('Не удалось синхронизировать слеш-команды', error)
  }
}

/**
 * JSON команды в виде, пригодном для ApplicationCommand.equals.
 * Билдер оставляет ключи со значением undefined (например, nsfw), и equals считает их отличием,
 * а contexts и integration_types, если команда их не задаёт, Discord заполняет сам
 */
function comparable(data: RESTPostAPIChatInputApplicationCommandsJSONBody, existing: ApplicationCommand) {
  const json: RESTPostAPIChatInputApplicationCommandsJSONBody = JSON.parse(JSON.stringify(data))
  json.contexts ??= existing.contexts ?? undefined
  json.integration_types ??= existing.integrationTypes ?? undefined
  // equals умеет сравнивать с JSON из SlashCommandBuilder, но в типах discord.js это не отражено
  return json as unknown as ComparableCommand
}
