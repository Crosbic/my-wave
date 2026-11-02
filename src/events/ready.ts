import { Client, Events } from 'discord.js'

import { syncCommands } from '../commands/sync.js'
import { BotEvent } from '../types/event.js'
import { logger } from '../utils/logger.js'

export const ready = {
  name: Events.ClientReady,
  once: true,
  async execute(client: Client<true>) {
    logger.info(`Бот запущен как ${client.user.tag}`)
    await syncCommands(client)
  }
} satisfies BotEvent<Events.ClientReady>
