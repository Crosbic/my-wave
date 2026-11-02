import { setTimeout as sleep } from 'timers/promises'

import { ButtonInteraction, GuildTextBasedChannel, PermissionFlagsBits, User, VoiceBasedChannel } from 'discord.js'

import { DatabaseService } from './database.service.js'
import { stoppedEmbed, WAVE_BUTTON_PREFIX, WaveAction, WaveSession } from './wave-session.js'
import { YandexAuthError, YandexMusicService } from './yandex-music.service.js'
import { describeError, UserFacingError } from '../utils/errors.js'
import { LONG_NOTICE_TTL, notify, SHORT_NOTICE_TTL } from '../utils/interactions.js'
import { isBotAdmin } from '../utils/permissions.js'

const STATION_ID = 'user:onyourwave'
const SHUTDOWN_TIMEOUT = 5_000

const WAVE_ACTIONS: readonly string[] = ['like', 'previous', 'pause', 'resume', 'stop', 'next'] satisfies WaveAction[]
// Кнопки сообщений, отправленных до перехода на префикс wave:
const LEGACY_BUTTON_IDS = new Set(['like', 'previous', 'pause', 'play', 'stop', 'next'])

export interface StartWaveOptions {
  user: User
  voiceChannel: VoiceBasedChannel
  textChannel: GuildTextBasedChannel
  yandexId: string
  accessToken: string
}

export class PlayerService {
  private static instance: PlayerService
  private readonly sessions = new Map<string, WaveSession>()
  private readonly starting = new Set<string>()
  private readonly yandexMusicService = YandexMusicService.getInstance()

  private constructor() {}

  public static getInstance(): PlayerService {
    if (!PlayerService.instance) {
      PlayerService.instance = new PlayerService()
    }
    return PlayerService.instance
  }

  /**
   * Запуск «Моей волны» на сервере. Если плеер уже запущен этим же пользователем, он перезапускается
   */
  public async startWave(options: StartWaveOptions): Promise<void> {
    const { user, voiceChannel } = options
    const guildId = voiceChannel.guild.id

    if (this.starting.has(guildId)) {
      throw new UserFacingError('Плеер на этом сервере уже запускается, подождите несколько секунд.')
    }

    const existing = this.sessions.get(guildId)
    if (existing && existing.owner.discordId !== user.id) {
      throw new UserFacingError(
        'В данный момент плеер уже используется другим пользователем. Дождитесь, пока он остановит воспроизведение.'
      )
    }

    this.starting.add(guildId)
    try {
      await existing?.destroy('Плеер перезапущен командой `/my-wave`.')

      const session = await WaveSession.create({
        voiceChannel,
        textChannel: options.textChannel,
        owner: { discordId: user.id, yandexId: options.yandexId, accessToken: options.accessToken },
        stationId: STATION_ID,
        onDestroy: destroyed => {
          if (this.sessions.get(destroyed.guildId) === destroyed) {
            this.sessions.delete(destroyed.guildId)
          }
        }
      })
      this.sessions.set(guildId, session)

      if (!(await session.start())) {
        throw new UserFacingError(session.stopReason ?? 'Не удалось запустить «Мою волну».')
      }
    } finally {
      this.starting.delete(guildId)
    }
  }

  /**
   * Остановка всех плееров, запущенных пользователем (например, после выхода из аккаунта Яндекса)
   */
  public async stopSessionsOf(discordUserId: string, reason: string): Promise<void> {
    const owned = [...this.sessions.values()].filter(session => session.owner.discordId === discordUserId)
    await Promise.all(owned.map(session => session.destroy(reason)))
  }

  /**
   * Остановка всех плееров при завершении работы бота
   */
  public async destroyAll(reason: string): Promise<void> {
    const pending = Promise.all([...this.sessions.values()].map(session => session.destroy(reason)))
    await Promise.race([pending, sleep(SHUTDOWN_TIMEOUT)])
  }

  /**
   * Обработка нажатий на кнопки плеера
   */
  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const { customId } = interaction
    if (!customId.startsWith(WAVE_BUTTON_PREFIX) && !LEGACY_BUTTON_IDS.has(customId)) {
      return
    }

    const action = customId.slice(WAVE_BUTTON_PREFIX.length)
    const session = interaction.guildId ? this.sessions.get(interaction.guildId) : undefined
    if (!session || session.messageId !== interaction.message.id || !isWaveAction(action)) {
      await this.disableStaleControls(interaction)
      return
    }

    try {
      // Результат большинства кнопок виден в самом плеере, поэтому нажатие подтверждаем без сообщения
      await interaction.deferUpdate()
      const denied = this.checkAccess(session, interaction, action)
      const notice = denied ? warning(denied) : await this.runAction(session, interaction, action)
      if (notice) {
        await notify(interaction, notice.content, notice.ttl)
      }
    } catch (error) {
      console.error(`Ошибка при обработке кнопки ${customId}:`, describeError(error))
      await notify(interaction, 'Произошла ошибка при управлении плеером.', LONG_NOTICE_TTL)
    }
  }

  /**
   * Кнопки на сообщении плеера, который уже не работает (например, после перезапуска бота): убираем их
   */
  private async disableStaleControls(interaction: ButtonInteraction): Promise<void> {
    try {
      await interaction.update({ embeds: [stoppedEmbed('Этот плеер больше не активен.')], components: [] })
    } catch (error) {
      console.error('Не удалось обновить сообщение неактивного плеера:', describeError(error))
    }
  }

  /**
   * Проверка прав на управление плеером. Возвращает текст отказа или null, если действие разрешено
   */
  private checkAccess(session: WaveSession, interaction: ButtonInteraction, action: WaveAction): string | null {
    // Лайк ставится в аккаунт нажавшего, поэтому доступен всем
    if (action === 'like') {
      return null
    }

    const { user } = interaction
    const isServerAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false
    if (user.id === session.owner.discordId || isBotAdmin(user) || isServerAdmin) {
      return null
    }

    if (!DatabaseService.getInstance().getPublicButtonsAccess(session.guildId)) {
      return 'Только пользователь, запустивший воспроизведение, может управлять плеером. Администраторы сервера могут включить общий доступ к кнопкам с помощью команды `/allow-buttons`.'
    }

    const userVoiceChannelId = interaction.guild?.voiceStates.cache.get(user.id)?.channelId
    if (!userVoiceChannelId || userVoiceChannelId !== session.voiceChannelId) {
      return 'Вы должны находиться в том же голосовом канале, что и бот, чтобы управлять плеером.'
    }

    return null
  }

  /**
   * Выполняет действие кнопки. Уведомление возвращается, только если результат не виден в самом плеере
   */
  private async runAction(
    session: WaveSession,
    interaction: ButtonInteraction,
    action: WaveAction
  ): Promise<Notice | null> {
    switch (action) {
      case 'like':
        return this.likeCurrentTrack(session, interaction.user)
      case 'previous':
        // Пустую историю показывает неактивная кнопка ⏮️, поэтому сообщаем только о сбое
        return (await session.previous()) === 'failed' ? warning('Не удалось воспроизвести предыдущий трек.') : null
      case 'pause':
        session.pause()
        return null
      case 'resume':
        session.resume()
        return null
      case 'stop':
        await session.destroy('Плеер был остановлен.')
        return null
      case 'next':
        await session.skip()
        return null
    }
  }

  /**
   * Лайк текущего трека в аккаунт пользователя, нажавшего кнопку.
   * Результат не виден в плеере и у каждого свой, поэтому о нём сообщаем
   */
  private async likeCurrentTrack(session: WaveSession, user: User): Promise<Notice | null> {
    // Пока трек загружается, кнопка 👍 неактивна
    const track = session.currentTrack
    if (!track) {
      return null
    }

    const userData = DatabaseService.getInstance().getUserData(user.id)
    if (!userData) {
      return warning('Вы не авторизованы в Яндекс Музыке. Используйте команду `/login` для авторизации.')
    }

    try {
      const liked = await this.yandexMusicService.likeTrack(
        userData.accessToken,
        userData.userInfo.id,
        YandexMusicService.fullTrackId(track)
      )
      return liked
        ? confirmation(`Трек «${track.title}» добавлен в «Мне нравится».`)
        : warning(`Не удалось добавить трек «${track.title}» в «Мне нравится».`)
    } catch (error) {
      if (error instanceof YandexAuthError) {
        return warning(
          'Ваш токен Яндекса недействителен или истёк. Получите новый через `/login-help` и выполните `/login`.'
        )
      }
      throw error
    }
  }
}

interface Notice {
  content: string
  ttl: number
}

// Подтверждение исчезает быстро, а отказ или ошибку нужно успеть прочитать
function confirmation(content: string): Notice {
  return { content, ttl: SHORT_NOTICE_TTL }
}

function warning(content: string): Notice {
  return { content, ttl: LONG_NOTICE_TTL }
}

function isWaveAction(action: string): action is WaveAction {
  return WAVE_ACTIONS.includes(action)
}
