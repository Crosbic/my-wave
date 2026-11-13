import { Events, Interaction } from 'discord.js'

import { commandsByName } from '../commands/index.js'
import { LOGIN_PREFIX, LoginService } from '../services/login.service.js'
import { PlayerService } from '../services/player.service.js'
import { WAVE_SETTINGS_PREFIX } from '../services/wave-settings.js'
import { BotEvent } from '../types/event.js'
import { respond } from '../utils/interactions.js'
import { logger } from '../utils/logger.js'

export const interactionCreate = {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction) {
    if (interaction.isMessageComponent() && interaction.customId.startsWith(WAVE_SETTINGS_PREFIX)) {
      await PlayerService.getInstance().handleSettingsPanel(interaction)
      return
    }

    if ((interaction.isButton() || interaction.isModalSubmit()) && interaction.customId.startsWith(LOGIN_PREFIX)) {
      await LoginService.getInstance().handleInteraction(interaction)
      return
    }

    if (interaction.isButton()) {
      await PlayerService.getInstance().handleButton(interaction)
      return
    }

    if (!interaction.isChatInputCommand()) return

    const command = commandsByName.get(interaction.commandName)

    if (!command) {
      logger.error(`Команда ${interaction.commandName} не найдена`)
      return
    }

    // С меткой сервера, как у плеера: по ней команду видно рядом с тем, что она запустила
    const log = interaction.guildId ? logger.child(`guild ${interaction.guildId}`) : logger
    log.info(`/${interaction.commandName} от ${interaction.user.tag}`)

    try {
      await command.execute(interaction)
    } catch (error) {
      log.error(`Ошибка при выполнении команды /${interaction.commandName}`, error)
      await respond(interaction, 'Произошла ошибка при выполнении команды!')
    }
  }
} satisfies BotEvent<Events.InteractionCreate>
