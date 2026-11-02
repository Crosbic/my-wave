import { Events, Interaction } from 'discord.js'

import { PlayerService } from '../services/player.service.js'
import { describeError } from '../utils/errors.js'
import { respond } from '../utils/interactions.js'

export const name = Events.InteractionCreate
export const once = false

export async function execute(interaction: Interaction) {
  if (interaction.isButton()) {
    await PlayerService.getInstance().handleButton(interaction)
    return
  }

  if (!interaction.isChatInputCommand()) return

  const command = interaction.client.commands.get(interaction.commandName)

  if (!command) {
    console.error(`Команда ${interaction.commandName} не найдена.`)
    return
  }

  try {
    await command.execute(interaction)
  } catch (error) {
    console.error(`Ошибка при выполнении команды /${interaction.commandName}:`, describeError(error))
    await respond(interaction, 'Произошла ошибка при выполнении команды!')
  }
}
