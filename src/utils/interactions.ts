import { ButtonInteraction, MessageFlags, RepliableInteraction } from 'discord.js'

import { logger } from './logger.js'

// Через сколько исчезают временные уведомления: короткие подтверждения и сообщения, которые нужно успеть прочитать
export const SHORT_NOTICE_TTL = 5_000
export const LONG_NOTICE_TTL = 15_000

/**
 * Отвечает пользователю, вызвавшему команду: учитывает отложенный ответ и никогда не бросает исключений.
 * Если передан ttl, ответ удаляется через ttl мс.
 * Для кнопок, подтверждённых через deferUpdate, используйте notify: editReply изменил бы само сообщение с кнопками
 */
export async function respond(interaction: RepliableInteraction, content: string, ttl?: number): Promise<void> {
  try {
    if (interaction.replied) {
      const message = await interaction.followUp({ content, flags: MessageFlags.Ephemeral })
      if (ttl) deleteLater(interaction, message.id, ttl)
      return
    }

    if (interaction.deferred) {
      await interaction.editReply({ content })
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral })
    }
    if (ttl) deleteLater(interaction, '@original', ttl)
  } catch (error) {
    logger.error('Не удалось ответить на взаимодействие', error)
  }
}

/**
 * Временное уведомление после нажатия кнопки, подтверждённого через deferUpdate. Исчезает само через ttl мс
 */
export async function notify(interaction: ButtonInteraction, content: string, ttl: number): Promise<void> {
  try {
    const message = await interaction.followUp({ content, flags: MessageFlags.Ephemeral })
    deleteLater(interaction, message.id, ttl)
  } catch (error) {
    logger.error('Не удалось отправить уведомление', error)
  }
}

/**
 * Убирает отложенный ответ («Бот думает...»), когда результат команды и так виден в канале
 */
export async function dismiss(interaction: RepliableInteraction): Promise<void> {
  try {
    await interaction.deleteReply()
  } catch (error) {
    logger.error('Не удалось удалить ответ на взаимодействие', error)
  }
}

/**
 * Удаляет ответ на взаимодействие через ttl мс. message — id сообщения или '@original'
 */
export function deleteLater(interaction: RepliableInteraction, message: string, ttl: number): void {
  setTimeout(() => {
    interaction.deleteReply(message).catch(error => {
      logger.error('Не удалось удалить уведомление', error)
    })
  }, ttl)
}
