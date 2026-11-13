import { Client, ClientEvents } from 'discord.js'

import { interactionCreate } from './interactionCreate.js'
import { ready } from './ready.js'
import { BotEvent } from '../types/event.js'
import { logger } from '../utils/logger.js'

/**
 * Подписывает клиента на все обработчики событий бота. Новый обработчик добавляется сюда же
 */
export function registerEvents(client: Client): void {
  register(client, ready)
  register(client, interactionCreate)
}

function register<K extends keyof ClientEvents>(client: Client, event: BotEvent<K>): void {
  // Без этого ошибка обработчика попала бы в лог как «необработанная», без названия события
  const listener = (...args: ClientEvents[K]) => {
    Promise.resolve()
      .then(() => event.execute(...args))
      .catch(error => logger.error(`Ошибка в обработчике события ${event.name}`, error))
  }

  if (event.once) {
    client.once(event.name, listener)
  } else {
    client.on(event.name, listener)
  }
}
