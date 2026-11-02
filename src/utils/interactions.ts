import { MessageFlags, RepliableInteraction } from 'discord.js'

import { describeError } from './errors.js'

/**
 * Отвечает пользователю, вызвавшему взаимодействие: учитывает отложенный ответ и никогда не бросает исключений
 */
export async function respond(interaction: RepliableInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content })
    } else if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral })
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral })
    }
  } catch (error) {
    console.error('Не удалось ответить на взаимодействие:', describeError(error))
  }
}
