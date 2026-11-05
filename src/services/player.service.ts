import { setTimeout as sleep } from 'timers/promises'

import {
  ButtonInteraction,
  GuildTextBasedChannel,
  MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuInteraction,
  User,
  VoiceBasedChannel
} from 'discord.js'

import { DatabaseService } from './database.service.js'
import { stoppedEmbed, WAVE_BUTTON_PREFIX, WaveAction, WaveSession } from './wave-session.js'
import {
  carouselPanel,
  isReshuffle,
  isWaveSettingKey,
  optionByValue,
  parsePanelId,
  readCarouselWave,
  readSettingsPanel,
  rememberedChoice,
  sameChoice,
  sanitizeChoice,
  settingsPanel,
  waveSeeds,
  withCarousel,
  withOption
} from './wave-settings.js'
import { YandexMusicService } from './yandex-music.service.js'
import { YandexAuthError } from '../errors/yandexAuthError.js'
import { CarouselWave, WaveChoice, WaveSettingGroup } from '../types/waveSettings.js'
import { UserFacingError } from '../utils/errors.js'
import { dismiss, LONG_NOTICE_TTL, notify, respond, SHORT_NOTICE_TTL } from '../utils/interactions.js'
import { logger } from '../utils/logger.js'
import { isBotAdmin } from '../utils/permissions.js'

const SHUTDOWN_TIMEOUT = 5_000

const WAVE_ACTIONS: readonly string[] = [
  'like',
  'previous',
  'pause',
  'resume',
  'stop',
  'next',
  'settings',
  'carousel',
  'reset'
] satisfies WaveAction[]
// Кнопки сообщений, отправленных до перехода на префикс wave:
const LEGACY_BUTTON_IDS = new Set(['like', 'previous', 'pause', 'play', 'stop', 'next'])

export interface StartWaveOptions {
  user: User
  voiceChannel: VoiceBasedChannel
  textChannel: GuildTextBasedChannel
  yandexId: string
  accessToken: string
  choice: WaveChoice
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
        choice: options.choice,
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
      logger.error(`Ошибка при обработке кнопки ${customId}`, error)
      await notify(interaction, 'Произошла ошибка при управлении плеером.', LONG_NOTICE_TTL)
    }
  }

  /**
   * Нажатия на панелях под плеером: списки и кнопки панели ⚙️ и список «🎡 Подборки»
   */
  public async handleSettingsPanel(interaction: MessageComponentInteraction): Promise<void> {
    const parsed = parsePanelId(interaction.customId)
    if (!parsed || !(interaction.isButton() || interaction.isStringSelectMenu())) {
      return
    }

    const { playerMessageId, field } = parsed
    try {
      if (interaction.isStringSelectMenu()) {
        const [value] = interaction.values
        if (field === 'carousel') {
          // Выбранная подборка сразу заиграет
          const wave = readCarouselWave(interaction.message.components, value)
          if (wave) {
            await this.playCarouselWave(interaction, playerMessageId, wave)
          }
        } else if (isWaveSettingKey(field)) {
          // Выбор в списке только меняет панель: волна перестроится по «Применить»
          const { groups, choice } = readSettingsPanel(interaction.message.components)
          const option = optionByValue(
            groups.find(group => group.key === field),
            value
          )
          await interaction.update(settingsPanel(groups, withOption(choice, field, option), playerMessageId))
        }
      } else if (field === 'reset') {
        const { groups } = readSettingsPanel(interaction.message.components)
        await interaction.update(settingsPanel(groups, {}, playerMessageId))
      } else if (field === 'submit' || field === 'default') {
        // «Применить» оставляет играющую подборку, а «По умолчанию» возвращает обычную «Мою волну»
        const { choice } = readSettingsPanel(interaction.message.components)
        await this.applyWaveSettings(interaction, playerMessageId, field === 'default' ? {} : choice, {
          keepCarousel: field === 'submit'
        })
      }
    } catch (error) {
      logger.error(`Ошибка на панели настроек волны (${interaction.customId})`, error)
      await respond(interaction, 'Произошла ошибка, попробуйте ещё раз.')
    }
  }

  /**
   * «Применить» и «По умолчанию» на панели настроек, открытой кнопкой ⚙️: волна перестраивается сразу,
   * панель закрывается. keepCarousel — оставить играющую подборку, если в панели не выбрано занятие
   */
  public async applyWaveSettings(
    interaction: ButtonInteraction,
    playerMessageId: string,
    choice: WaveChoice,
    { keepCarousel }: { keepCarousel: boolean }
  ): Promise<void> {
    await this.changeWave(interaction, playerMessageId, {
      action: 'settings',
      choice: current => (keepCarousel ? withCarousel(choice, current) : choice),
      remember: true,
      failure: 'Не удалось применить настройки, волна играет с прежними. Попробуйте ещё раз.'
    })
  }

  /**
   * Выбор в списке «🎡 Подборки»: подборка сразу заиграет. Настройки сбрасываются, как при нажатии на плитку
   * в приложении. Подборка запоминается как настройка, кроме «Встряхнуть Мою волну»: это разовое действие,
   * и запомненные настройки после него остаются прежними
   */
  public async playCarouselWave(
    interaction: StringSelectMenuInteraction,
    playerMessageId: string,
    wave: CarouselWave
  ): Promise<void> {
    await this.changeWave(interaction, playerMessageId, {
      action: 'carousel',
      choice: () => ({ wave }),
      remember: !isReshuffle(wave),
      failure: 'Не удалось включить подборку, волна играет с прежними настройками. Попробуйте ещё раз.'
    })
  }

  /**
   * Смена волны из панели под плеером. Если плеер уже другой или прав нет, панель объясняет почему,
   * а после успешной смены закрывается
   */
  private async changeWave(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    playerMessageId: string,
    options: {
      action: WaveAction
      choice: (current: WaveChoice) => WaveChoice
      remember: boolean
      failure: string
    }
  ): Promise<void> {
    const session = interaction.guildId ? this.sessions.get(interaction.guildId) : undefined
    if (!session || session.messageId !== playerMessageId) {
      await interaction.update({
        content: 'Этот плеер больше не активен. Запустите волну командой `/my-wave`.',
        components: []
      })
      return
    }

    const denied = this.checkAccess(session, interaction, options.action)
    if (denied) {
      await interaction.update({ content: denied })
      return
    }

    await interaction.deferUpdate()
    const choice = options.choice(session.waveChoice)
    if (!(await this.retuneWave(session, interaction.user, choice, options.remember))) {
      const stopReason = session.stopReason
      await interaction.editReply(stopReason ? { content: stopReason, components: [] } : { content: options.failure })
      return
    }

    await dismiss(interaction)
  }

  /**
   * Смена настроек играющей волны. Если настройки те же, волна просто играет дальше, без новой сессии.
   * Настройки вместе с подборкой запоминаются за тем, кто их поменял, даже в чужом плеере: с ними запустится
   * его следующий /my-wave, а запомненные настройки владельца плеера не меняются
   */
  private async retuneWave(session: WaveSession, user: User, choice: WaveChoice, remember = true): Promise<boolean> {
    if (sameChoice(session.waveChoice, choice)) {
      return true
    }

    if (!(await session.retune(choice))) {
      return false
    }

    if (remember) {
      DatabaseService.getInstance().saveWaveChoice(user.id, rememberedChoice(choice))
    }
    return true
  }

  /**
   * Кнопки на сообщении плеера, который уже не работает (например, после перезапуска бота): убираем их
   */
  private async disableStaleControls(interaction: ButtonInteraction): Promise<void> {
    try {
      await interaction.update({ embeds: [stoppedEmbed('Этот плеер больше не активен.')], components: [] })
    } catch (error) {
      logger.error('Не удалось обновить сообщение неактивного плеера', error)
    }
  }

  /**
   * Проверка прав на управление плеером. Возвращает текст отказа или null, если действие разрешено
   */
  private checkAccess(
    session: WaveSession,
    interaction: MessageComponentInteraction,
    action: WaveAction
  ): string | null {
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
      case 'settings':
        return this.openWaveSettings(session, interaction)
      case 'carousel':
        return this.openCarousel(session, interaction)
      case 'reset':
        return this.resetWaveSettings(session, interaction)
    }
  }

  /**
   * Подборки карусели под играющую волну. Видны только нажавшему, загружаются токеном владельца плеера
   */
  private async openCarousel(session: WaveSession, interaction: ButtonInteraction): Promise<Notice | null> {
    let waves: CarouselWave[]
    try {
      waves = await this.yandexMusicService.getWaveCarousel(session.owner.accessToken, waveSeeds(session.waveChoice))
    } catch (error) {
      logger.error('Не удалось загрузить подборки «Моей волны»', error)
      return warning('Не удалось загрузить подборки. Попробуйте ещё раз.')
    }

    const panel = carouselPanel(waves, session.waveChoice, interaction.message.id)
    if (!panel) {
      return warning('Яндекс Музыка не предложила подборок. Попробуйте позже.')
    }

    await interaction.followUp({ ...panel, flags: MessageFlags.Ephemeral })
    return null
  }

  /**
   * Сброс настроек из плеера: сразу играет «Моя волна» без настроек. Результат виден в плеере,
   * поэтому сообщаем только о сбое
   */
  private async resetWaveSettings(session: WaveSession, interaction: ButtonInteraction): Promise<Notice | null> {
    if (await this.retuneWave(session, interaction.user, {})) {
      return null
    }

    // Если плеер остановился (например, истёк токен), причина уже показана в нём
    return session.stopReason
      ? null
      : warning('Не удалось сбросить настройки, волна играет с прежними. Попробуйте ещё раз.')
  }

  /**
   * Панель настроек для смены волны на ходу. Видна только нажавшему, варианты загружаются токеном владельца плеера
   */
  private async openWaveSettings(session: WaveSession, interaction: ButtonInteraction): Promise<Notice | null> {
    let groups: WaveSettingGroup[]
    try {
      groups = await this.yandexMusicService.getWaveSettings(session.owner.accessToken)
    } catch (error) {
      logger.error('Не удалось загрузить настройки «Моей волны»', error)
      return warning('Не удалось загрузить настройки «Моей волны». Попробуйте ещё раз.')
    }

    const panel = settingsPanel(groups, sanitizeChoice(session.waveChoice, groups), interaction.message.id)
    await interaction.followUp({ ...panel, flags: MessageFlags.Ephemeral })
    return null
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
