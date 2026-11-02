import { ChatInputCommandInteraction, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'

import { DatabaseService } from '../services/database.service.js'
import { PlayerService } from '../services/player.service.js'
import { UserFacingError } from '../utils/errors.js'
import { dismiss, respond } from '../utils/interactions.js'

export const data = new SlashCommandBuilder()
  .setName('my-wave')
  .setDescription('Воспроизвести треки из "Моя волна" в Яндекс Музыке')

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild() || !interaction.channel) {
    await respond(interaction, 'Эта команда может быть использована только на сервере.')
    return
  }

  const userData = DatabaseService.getInstance().getUserData(interaction.user.id)
  if (!userData) {
    await respond(interaction, 'Вы не авторизованы! Используйте команду `/login` для входа через Яндекс.')
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const { guild } = interaction
  const voiceState =
    guild.voiceStates.cache.get(interaction.user.id) ??
    (await guild.voiceStates.fetch(interaction.user.id).catch(() => null))
  const voiceChannel = voiceState?.channel
  if (!voiceChannel) {
    await respond(interaction, 'Вы должны находиться в голосовом канале, чтобы использовать эту команду!')
    return
  }

  const me = guild.members.me ?? (await guild.members.fetchMe())
  const voicePermissions = voiceChannel.permissionsFor(me)
  if (
    !voicePermissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
  ) {
    await respond(interaction, 'У меня нет прав для подключения или воспроизведения аудио в этом голосовом канале!')
    return
  }
  if (voiceChannel.full && !voicePermissions.has(PermissionFlagsBits.MoveMembers)) {
    await respond(interaction, 'Голосовой канал заполнен, я не могу к нему подключиться.')
    return
  }

  const textChannel = interaction.channel
  const sendPermission = textChannel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages
  if (
    !interaction.appPermissions.has([PermissionFlagsBits.ViewChannel, sendPermission, PermissionFlagsBits.EmbedLinks])
  ) {
    await respond(
      interaction,
      'Мне не хватает прав в этом текстовом канале, чтобы показать плеер: нужны «Просмотр канала», «Отправка сообщений» и «Встраивать ссылки».'
    )
    return
  }

  try {
    await PlayerService.getInstance().startWave({
      user: interaction.user,
      voiceChannel,
      textChannel,
      yandexId: userData.userInfo.id,
      accessToken: userData.accessToken
    })
    // Подтверждение не нужно: в канале уже появился плеер
    await dismiss(interaction)
  } catch (error) {
    if (error instanceof UserFacingError) {
      await respond(interaction, error.message)
      return
    }
    throw error
  }
}
