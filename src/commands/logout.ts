import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js'

import { DatabaseService } from '../services/database.service.js'
import { PlayerService } from '../services/player.service.js'
import { DEVICE_NAME, YandexOAuthService } from '../services/yandex-oauth.service.js'
import { LONG_NOTICE_TTL, respond } from '../utils/interactions.js'
import { logger } from '../utils/logger.js'

export const data = new SlashCommandBuilder().setName('logout').setDescription('Выйти из аккаунта Яндекса')

/**
 * Бот удаляет токен и останавливает плееры пользователя. Токен, полученный входом по коду, отзывается и в Яндексе.
 * Токен, вставленный вручную, мог пригодиться и в других приложениях, поэтому его бот только удаляет
 */
export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id
  const db = DatabaseService.getInstance()

  if (!db.hasUserToken(userId)) {
    await respond(interaction, 'Вы не авторизованы через Яндекс. Используйте `/login` чтобы авторизоваться.')
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const user = db.getUserData(userId)
  db.removeUserToken(userId)
  // Плееры пользователя работают на его токене, поэтому останавливаем их вместе с выходом
  await PlayerService.getInstance().stopSessionsOf(
    userId,
    'Пользователь, запустивший плеер, вышел из аккаунта Яндекса.'
  )

  if (!user?.refreshToken) {
    await respond(interaction, 'Вы вышли из аккаунта Яндекса: бот удалил ваш токен.', LONG_NOTICE_TTL)
    return
  }

  try {
    await YandexOAuthService.getInstance().revokeToken(user.accessToken)
    await respond(
      interaction,
      'Вы вышли из аккаунта Яндекса: бот удалил ваш токен и отозвал его в Яндексе.',
      LONG_NOTICE_TTL
    )
  } catch (error) {
    logger.warn('Не удалось отозвать токен Яндекса при выходе', error)
    // Без подсказки пользователь решит, что доступ отозван, поэтому сообщение остаётся
    await respond(
      interaction,
      `Вы вышли из аккаунта Яндекса, но отозвать токен в Яндексе не удалось. ` +
        `Отключите «${DEVICE_NAME}» на странице управления доступом в Яндекс ID.`
    )
  }
}
