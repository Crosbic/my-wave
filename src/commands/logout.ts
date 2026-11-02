import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js'

import { DatabaseService } from '../services/database.service.js'
import { PlayerService } from '../services/player.service.js'

export const data = new SlashCommandBuilder().setName('logout').setDescription('Выйти из аккаунта Яндекса')

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id
  const db = DatabaseService.getInstance()

  if (!db.hasUserToken(userId)) {
    await interaction.reply({
      content: 'Вы не авторизованы через Яндекс. Используйте `/login` чтобы авторизоваться.',
      flags: MessageFlags.Ephemeral
    })
    return
  }

  db.removeUserToken(userId)
  // Плееры пользователя работают на его токене, поэтому останавливаем их вместе с выходом
  await PlayerService.getInstance().stopSessionsOf(
    userId,
    'Пользователь, запустивший плеер, вышел из аккаунта Яндекса.'
  )

  await interaction.reply({
    content: 'Вы успешно удалили данные Яндекс аккаунта у бота!',
    flags: MessageFlags.Ephemeral
  })
}
