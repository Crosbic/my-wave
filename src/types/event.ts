import { ClientEvents } from 'discord.js'

/**
 * Обработчик события клиента Discord
 */
export interface BotEvent<K extends keyof ClientEvents> {
  name: K
  once?: boolean
  execute(...args: ClientEvents[K]): unknown
}
