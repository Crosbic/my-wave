import { PermissionFlagsBits, RepliableInteraction } from 'discord.js'

import { DatabaseService } from './database.service.js'
import { PlayerService } from './player.service.js'
import { YandexOAuthService } from './yandex-oauth.service.js'
import { YandexAuthError } from '../errors/yandexAuthError.js'
import { StoredUser, YandexTokens } from '../types/userData.js'
import { UserFacingError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

const DAY = 24 * 60 * 60 * 1000
// Токен Яндекса живёт год, а Яндекс советует продлевать его раз в три месяца. Продлеваем при запуске волны,
// когда до конца срока осталось меньше девяти месяцев: если запускать волну хотя бы раз в девять месяцев,
// входить заново не придётся
const REFRESH_WHEN_LEFT = 270 * DAY

const log = logger.child('login')

/**
 * Итог запуска: волна играет, не запустилась по понятной пользователю причине или нужно войти в Яндекс Музыку
 */
export type LaunchResult = { status: 'started' } | { status: 'failed'; message: string } | { status: 'unauthorized' }

/**
 * Запуск «Моей волны» в голосовом канале пользователя: по /my-wave или сразу после входа, который начался с неё.
 * Волна запускается с последними настройками пользователя, поменять их можно кнопками в плеере
 */
export async function launchWave(interaction: RepliableInteraction): Promise<LaunchResult> {
  if (!interaction.inCachedGuild() || !interaction.channel) {
    return failed('Эта команда может быть использована только на сервере.')
  }

  const db = DatabaseService.getInstance()
  const stored = db.getUserData(interaction.user.id)
  if (!stored) {
    return { status: 'unauthorized' }
  }

  const { guild } = interaction
  const voiceState =
    guild.voiceStates.cache.get(interaction.user.id) ??
    (await guild.voiceStates.fetch(interaction.user.id).catch(() => null))
  const voiceChannel = voiceState?.channel
  if (!voiceChannel) {
    return failed('Вы должны находиться в голосовом канале, чтобы использовать эту команду!')
  }

  const me = guild.members.me ?? (await guild.members.fetchMe())
  const voicePermissions = voiceChannel.permissionsFor(me)
  if (
    !voicePermissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
  ) {
    return failed('У меня нет прав для подключения или воспроизведения аудио в этом голосовом канале!')
  }
  if (voiceChannel.full && !voicePermissions.has(PermissionFlagsBits.MoveMembers)) {
    return failed('Голосовой канал заполнен, я не могу к нему подключиться.')
  }

  const textChannel = interaction.channel
  const sendPermission = textChannel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages
  if (
    !interaction.appPermissions.has([PermissionFlagsBits.ViewChannel, sendPermission, PermissionFlagsBits.EmbedLinks])
  ) {
    return failed(
      'Мне не хватает прав в этом текстовом канале, чтобы показать плеер: нужны «Просмотр канала», «Отправка сообщений» и «Встраивать ссылки».'
    )
  }

  const user = await refreshIfStale(interaction.user.id, stored)
  try {
    await PlayerService.getInstance().startWave({
      user: interaction.user,
      voiceChannel,
      textChannel,
      yandexId: user.userInfo.id,
      accessToken: user.accessToken,
      choice: db.getWaveChoice(interaction.user.id)
    })
    return { status: 'started' }
  } catch (error) {
    if (error instanceof YandexAuthError) {
      return { status: 'unauthorized' }
    }
    if (error instanceof UserFacingError) {
      return failed(error.message)
    }
    throw error
  }
}

/**
 * Продлевает токен, полученный входом по коду, если до конца его срока осталось меньше девяти месяцев.
 * Если продлить не удалось, остаётся прежний токен: скорее всего, он ещё действует
 */
async function refreshIfStale(discordId: string, user: StoredUser): Promise<StoredUser> {
  if (!user.refreshToken || !user.expiresAt || user.expiresAt - Date.now() > REFRESH_WHEN_LEFT) {
    return user
  }

  let tokens: YandexTokens | null
  try {
    tokens = await YandexOAuthService.getInstance().refreshTokens(user.refreshToken)
  } catch (error) {
    log.warn(`Не удалось продлить токен Яндекса пользователя ${discordId}`, error)
    return user
  }
  if (!tokens) {
    // Если токен и правда больше не действует, запуск не удастся, и /my-wave предложит войти заново
    log.warn(`Яндекс отказался продлить токен пользователя ${discordId}`)
    return user
  }

  DatabaseService.getInstance().saveUserToken(discordId, tokens, user.userInfo)
  // Прежний токен может перестать работать, поэтому другие плееры пользователя тоже переходят на новый
  PlayerService.getInstance().updateOwnerToken(discordId, user.userInfo.id, tokens.accessToken)
  log.info(
    `Токен Яндекса пользователя ${discordId} продлён` +
      (tokens.expiresAt ? ` до ${new Date(tokens.expiresAt).toISOString()}` : '')
  )
  return { ...tokens, userInfo: user.userInfo }
}

function failed(message: string): LaunchResult {
  return { status: 'failed', message }
}
