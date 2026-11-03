import {
  ChatInputCommandInteraction,
  GuildTextBasedChannel,
  MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
  RepliableInteraction,
  SlashCommandBuilder,
  VoiceBasedChannel
} from 'discord.js'

import { YandexAuthError } from '../errors/yandexAuthError.js'
import { DatabaseService } from '../services/database.service.js'
import { PlayerService } from '../services/player.service.js'
import {
  describeChoice,
  isWaveSettingKey,
  optionByValue,
  parsePanelId,
  readSettingsPanel,
  sanitizeChoice,
  settingsPanel,
  withOption
} from '../services/wave-settings.js'
import { YandexMusicService } from '../services/yandex-music.service.js'
import { WaveChoice, WaveSettingGroup } from '../types/waveSettings.js'
import { UserFacingError } from '../utils/errors.js'
import { dismiss, LONG_NOTICE_TTL, respond } from '../utils/interactions.js'
import { logger } from '../utils/logger.js'

export const data = new SlashCommandBuilder()
  .setName('my-wave')
  .setDescription('Воспроизвести треки из "Моя волна" в Яндекс Музыке')

const NOT_AUTHORIZED = 'Вы не авторизованы! Используйте команду `/login` для входа через Яндекс.'
const TOKEN_EXPIRED =
  'Ваш токен Яндекса недействителен или истёк. Получите новый через `/login-help` и выполните `/login`.'

interface WaveTarget {
  voiceChannel: VoiceBasedChannel
  textChannel: GuildTextBasedChannel
}

/**
 * Открывает панель настроек волны, которую видит только вызвавший. Волна запускается кнопкой «Запустить»
 */
export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild() || !interaction.channel) {
    await respond(interaction, 'Эта команда может быть использована только на сервере.')
    return
  }

  const db = DatabaseService.getInstance()
  const userData = db.getUserData(interaction.user.id)
  if (!userData) {
    await respond(interaction, NOT_AUTHORIZED)
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  // Проверяем сразу, чтобы не настраивать волну, которую всё равно не запустить
  const target = await resolveTarget(interaction)
  if (typeof target === 'string') {
    await respond(interaction, target)
    return
  }

  const saved = db.getWaveChoice(interaction.user.id)
  let groups: WaveSettingGroup[]
  try {
    groups = await YandexMusicService.getInstance().getWaveSettings(userData.accessToken)
  } catch (error) {
    if (error instanceof YandexAuthError) {
      await respond(interaction, TOKEN_EXPIRED)
      return
    }
    // Без списка настроек волну всё равно можно запустить: с последними выбранными
    logger.warn('Не удалось загрузить настройки «Моей волны», запускаем с сохранёнными', error)
    const description = describeChoice(saved)
    await launchWave(
      interaction,
      saved,
      `Не удалось загрузить настройки «Моей волны», поэтому волна запущена ${
        description ? `с последними выбранными: ${description}` : 'с настройками по умолчанию'
      }. Сменить их можно кнопкой «⚙️ Настроить волну» в плеере.`
    )
    return
  }

  await interaction.editReply(settingsPanel(groups, sanitizeChoice(saved, groups), { kind: 'launch' }))
}

/**
 * Нажатия на панели настроек волны: выбор в списках, «Сбросить», «По умолчанию», «Запустить»
 * и «Применить» (панель из ⚙️ в плеере)
 */
export async function handleSettingsPanel(interaction: MessageComponentInteraction): Promise<void> {
  const parsed = parsePanelId(interaction.customId)
  if (!parsed || !interaction.inCachedGuild() || !(interaction.isButton() || interaction.isStringSelectMenu())) {
    return
  }

  const { target, field } = parsed
  const { groups, choice } = readSettingsPanel(interaction.message.components)

  try {
    if (field === 'reset') {
      await interaction.update(settingsPanel(groups, {}, target))
    } else if (isWaveSettingKey(field)) {
      if (interaction.isStringSelectMenu()) {
        const option = optionByValue(
          groups.find(group => group.key === field),
          interaction.values[0]
        )
        await interaction.update(settingsPanel(groups, withOption(choice, field, option), target))
      }
    } else if (interaction.isButton()) {
      // «По умолчанию» запускает волну без настроек, что бы ни было выбрано в списках
      const selected = field === 'default' ? {} : choice
      if (target.kind === 'launch') {
        await interaction.deferUpdate()
        await launchWave(interaction, selected)
      } else {
        await PlayerService.getInstance().applyWaveSettings(interaction, target.playerMessageId, selected)
      }
    }
  } catch (error) {
    logger.error(`Ошибка на панели настроек волны (${interaction.customId})`, error)
    await respond(interaction, 'Произошла ошибка, попробуйте ещё раз.')
  }
}

/**
 * Запуск волны с выбранными настройками. Ответ на взаимодействие уже отложен: при ошибке в нём появится причина,
 * а при успехе он удаляется, ведь в канале уже появился плеер. Если передан notice, вместо этого показывается он
 */
async function launchWave(
  interaction: RepliableInteraction<'cached'>,
  choice: WaveChoice,
  notice?: string
): Promise<void> {
  const db = DatabaseService.getInstance()
  const userData = db.getUserData(interaction.user.id)
  if (!userData) {
    await respond(interaction, NOT_AUTHORIZED)
    return
  }

  const target = await resolveTarget(interaction)
  if (typeof target === 'string') {
    await respond(interaction, target)
    return
  }

  try {
    await PlayerService.getInstance().startWave({
      user: interaction.user,
      ...target,
      yandexId: userData.userInfo.id,
      accessToken: userData.accessToken,
      choice
    })
  } catch (error) {
    if (error instanceof UserFacingError) {
      await respond(interaction, error.message)
      return
    }
    throw error
  }

  db.saveWaveChoice(interaction.user.id, choice)
  if (notice) {
    await respond(interaction, notice, LONG_NOTICE_TTL)
  } else {
    await dismiss(interaction)
  }
}

/**
 * Голосовой канал пользователя и текстовый канал для плеера. Строка — причина, по которой запустить волну нельзя
 */
async function resolveTarget(interaction: RepliableInteraction<'cached'>): Promise<WaveTarget | string> {
  const { guild, channel: textChannel } = interaction
  if (!textChannel) {
    return 'Эта команда может быть использована только на сервере.'
  }

  const voiceState =
    guild.voiceStates.cache.get(interaction.user.id) ??
    (await guild.voiceStates.fetch(interaction.user.id).catch(() => null))
  const voiceChannel = voiceState?.channel
  if (!voiceChannel) {
    return 'Вы должны находиться в голосовом канале, чтобы запустить волну!'
  }

  const me = guild.members.me ?? (await guild.members.fetchMe())
  const voicePermissions = voiceChannel.permissionsFor(me)
  if (
    !voicePermissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
  ) {
    return 'У меня нет прав для подключения или воспроизведения аудио в этом голосовом канале!'
  }
  if (voiceChannel.full && !voicePermissions.has(PermissionFlagsBits.MoveMembers)) {
    return 'Голосовой канал заполнен, я не могу к нему подключиться.'
  }

  const sendPermission = textChannel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages
  if (
    !interaction.appPermissions.has([PermissionFlagsBits.ViewChannel, sendPermission, PermissionFlagsBits.EmbedLinks])
  ) {
    return 'Мне не хватает прав в этом текстовом канале, чтобы показать плеер: нужны «Просмотр канала», «Отправка сообщений» и «Встраивать ссылки».'
  }

  return { voiceChannel, textChannel }
}
