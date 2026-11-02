import { Client, ClientEvents } from 'discord.js'

import { interactionCreate } from './interactionCreate.js'
import { ready } from './ready.js'
import { BotEvent } from '../types/event.js'

/**
 * Подписывает клиента на все обработчики событий бота. Новый обработчик добавляется сюда же
 */
export function registerEvents(client: Client): void {
  register(client, ready)
  register(client, interactionCreate)
}

function register<K extends keyof ClientEvents>(client: Client, event: BotEvent<K>): void {
  const listener = (...args: ClientEvents[K]) => event.execute(...args)

  if (event.once) {
    client.once(event.name, listener)
  } else {
    client.on(event.name, listener)
  }
}
