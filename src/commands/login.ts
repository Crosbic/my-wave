import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js'

import { YandexAuthError } from '../errors/yandexAuthError.js'
import { DatabaseService } from '../services/database.service.js'
import { YandexMusicService } from '../services/yandex-music.service.js'
import { LONG_NOTICE_TTL, respond } from '../utils/interactions.js'
import { logger } from '../utils/logger.js'

export const data = new SlashCommandBuilder()
  .setName('login')
  .setDescription('Авторизация через Яндекс, используя токен')
  .addStringOption(option => option.setName('token').setDescription('Токен доступа Яндекс').setRequired(true))

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id
  const db = DatabaseService.getInstance()
  const token = interaction.options.getString('token', true).trim()

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  let userInfoResult
  try {
    userInfoResult = await YandexMusicService.getInstance().getUserInfo(token)
  } catch (error) {
    if (error instanceof YandexAuthError) {
      await respond(interaction, 'Токен недействителен или истёк. Получите новый токен по инструкции из `/login-help`.')
      return
    }
    logger.error('Ошибка при авторизации', error)
    await respond(
      interaction,
      'Не удалось получить информацию о пользователе от Яндекса. Пожалуйста, попробуйте позже.'
    )
    return
  }

  const { userInfo, hasPlus } = userInfoResult
  if (!hasPlus) {
    await respond(
      interaction,
      'Для использования бота требуется активная подписка Яндекс Плюс. Активируйте подписку и попробуйте снова.'
    )
    return
  }

  // Повторный вход просто обновляет токен: так можно заменить истёкший токен без /logout
  const wasAuthorized = db.hasUserToken(userId)
  db.saveUserToken(userId, token, userInfo)

  // Подтверждение нужно (больше ничего не меняется), но держать его в чате незачем
  await respond(
    interaction,
    wasAuthorized
      ? `Токен обновлён! Вы вошли как ${userInfo.nickName}.`
      : `Авторизация успешно завершена! Вы вошли как ${userInfo.nickName}. Теперь вы можете использовать команды бота.`,
    LONG_NOTICE_TTL
  )
}
