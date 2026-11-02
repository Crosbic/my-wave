import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js'

import { DatabaseService } from '../services/database.service.js'
import { PlayerService } from '../services/player.service.js'
import { LONG_NOTICE_TTL, respond } from '../utils/interactions.js'

export const data = new SlashCommandBuilder().setName('logout').setDescription('Выйти из аккаунта Яндекса')

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id
  const db = DatabaseService.getInstance()

  if (!db.hasUserToken(userId)) {
    await respond(interaction, 'Вы не авторизованы через Яндекс. Используйте `/login` чтобы авторизоваться.')
    return
  }

  db.removeUserToken(userId)
  // Плееры пользователя работают на его токене, поэтому останавливаем их вместе с выходом
  await PlayerService.getInstance().stopSessionsOf(
    userId,
    'Пользователь, запустивший плеер, вышел из аккаунта Яндекса.'
  )

  await respond(interaction, 'Вы успешно удалили данные Яндекс аккаунта у бота!', LONG_NOTICE_TTL)
}
