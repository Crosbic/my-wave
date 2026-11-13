import { setTimeout as sleep } from 'timers/promises'

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  EmbedBuilder,
  escapeMarkdown,
  Guild,
  GuildTextBasedChannel,
  Message,
  MessageEditOptions,
  RESTJSONErrorCodes,
  VoiceBasedChannel
} from 'discord.js'

import {
  AudioPlayer,
  AudioPlayerError,
  AudioPlayerState,
  AudioPlayerStatus,
  AudioResource,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnection,
  VoiceConnectionState,
  VoiceConnectionStatus
} from '@discordjs/voice'

import { createTrackResource, discard } from './track-resource.js'
import {
  describeConnectionState,
  discoverVoiceAddress,
  isDaveActive,
  isMissedTransition,
  isResuming,
  isVoiceSocketStalled,
  logDaveMessage,
  voiceProblem
} from './voice-health.js'
import { describeChoice, isDefaultChoice, waveSeeds } from './wave-settings.js'
import { WaveFeedback, YandexMusicService } from './yandex-music.service.js'
import { YandexAuthError } from '../errors/yandexAuthError.js'
import { WaveChoice } from '../types/waveSettings.js'
import { IStationBatch, IWaveSession, IYandexTrack } from '../types/yandexTrack.js'
import { UserFacingError } from '../utils/errors.js'
import { Logger, logger, MessageLevel } from '../utils/logger.js'

const VOLUME = 0.8 // Чтоб не оглохли
// Пять страниц «📜 Истории»
const HISTORY_SIZE = 25
// Сколько последних треков передаём волне в queue, как веб-клиент Яндекс Музыки
const RECENT_QUEUE_SIZE = 2
// Сколько раз запускаем трек, если поток оборвался в первые retryWindow мс
const MAX_TRACK_ATTEMPTS = 3
// Сколько треков подряд может не воспроизвестись, прежде чем плеер остановится
const MAX_FAILED_TRACKS = 5
const BATCH_ATTEMPTS = 3
// Сколько раз за RECONNECT_WINDOW плеер может зайти в канал заново: если чаще, соединение явно не держится
const MAX_RECONNECTS = 5
const RECONNECT_WINDOW = 10 * 60_000
// Сколько раз подряд голосовой сервер может не ответить на проверку адреса, прежде чем она отключится до следующего соединения
const UDP_CHECK_ATTEMPTS = 3

/**
 * Задержки и таймауты сессии в миллисекундах
 */
export interface WaveTimings {
  connectTimeout: number
  reconnectTimeout: number
  activityCheckInterval: number
  emptyChannelTimeout: number
  noPlaybackTimeout: number
  pauseTimeout: number
  // Если поток оборвался раньше этого времени, трек запускается заново
  retryWindow: number
  retryDelay: number
  // Через сколько после старта проверяем, что звук действительно пошёл: битый поток тоже ненадолго переходит в Playing
  startConfirmDelay: number
  // Сколько соединение может не восстанавливаться, а сквозное шифрование — быть не готово, прежде чем бот зайдёт
  // в канал заново. Дольше окна смены ключей DAVE в 10 секунд
  voiceStallTimeout: number
  // Как часто сверяем адрес, с которого голосовой сервер получает звук бота, и сколько ждём ответа
  udpCheckInterval: number
  udpCheckTimeout: number
  // Сколько голосовой сервер может не отвечать на heartbeat, прежде чем бот зайдёт в канал заново
  heartbeatTimeout: number
  // Сколько бот пытается зайти в канал заново, прежде чем остановить плеер, и пауза между попытками
  voiceRecoveryTimeout: number
  rejoinDelay: number
}

export const DEFAULT_TIMINGS: WaveTimings = {
  connectTimeout: 20_000,
  reconnectTimeout: 5_000,
  // Часто, чтобы зависшее голосовое соединение замечалось быстро
  activityCheckInterval: 2_000,
  emptyChannelTimeout: 20_000,
  noPlaybackTimeout: 30_000,
  pauseTimeout: 10 * 60_000,
  retryWindow: 10_000,
  retryDelay: 2_000,
  startConfirmDelay: 1_000,
  voiceStallTimeout: 15_000,
  udpCheckInterval: 15_000,
  udpCheckTimeout: 3_000,
  heartbeatTimeout: 5_000,
  voiceRecoveryTimeout: 3 * 60_000,
  rejoinDelay: 5_000
}

const COLOR_PLAYING = '#FFCC00'
const COLOR_STOPPED = '#FF0000'
const FOOTER = 'Яндекс Музыка'

export const WAVE_BUTTON_PREFIX = 'wave:'
export type WaveAction =
  'like' | 'previous' | 'pause' | 'resume' | 'stop' | 'next' | 'history' | 'settings' | 'carousel' | 'reset'

type EndReason = 'finished' | 'skip' | 'error'

interface QueueItem {
  track: IYandexTrack
  // Сессия волны и партия, из которых пришёл трек: фидбэк по треку уходит туда же, даже после смены настроек
  sessionId: string
  batchId: string | null
  // Фидбэк волны отправляется только для первого воспроизведения трека
  feedback: 'pending' | 'started' | 'done'
  // Номер последнего запуска трека: по нему «📜 История» показывает последние треки первыми
  lastPlay?: number
}

interface Playback {
  item: QueueItem
  resource: AudioResource
  attempt: number
}

export interface WaveOwner {
  discordId: string
  yandexId: string
  accessToken: string
}

export interface WaveSessionOptions {
  voiceChannel: VoiceBasedChannel
  textChannel: GuildTextBasedChannel
  owner: WaveOwner
  choice: WaveChoice
  onDestroy: (session: WaveSession) => void
  timings?: Partial<WaveTimings>
}

/**
 * Сессия «Моей волны» на одном сервере: голосовое соединение, плеер, очередь и сообщение с кнопками.
 * Переключения треков выполняются строго по очереди, а destroy() освобождает все ресурсы сессии
 */
export class WaveSession {
  readonly guildId: string
  readonly owner: WaveOwner

  private readonly guild: Guild
  private readonly connection: VoiceConnection
  private readonly player: AudioPlayer
  private readonly onDestroy: (session: WaveSession) => void
  private readonly yandex = YandexMusicService.getInstance()
  private readonly timings: WaveTimings
  private readonly log: Logger
  private readonly activityTimer: NodeJS.Timeout
  private readonly udpCheckTimer: NodeJS.Timeout
  // Прерывает ожидания сессии, когда её останавливают
  private readonly lifetime = new AbortController()

  private message: Message | null
  private choice: WaveChoice
  // Сессия волны в Яндекс Музыке. Создаётся при первой загрузке треков и заново, если Яндекс Музыка её завершила
  private radioSessionId: string | null = null
  private readonly queue: QueueItem[] = []
  private readonly history: QueueItem[] = []
  // Треки, к которым вернёмся после ⏮️: последний элемент играет следующим
  private readonly upcoming: QueueItem[] = []
  private current: Playback | null = null
  private failedResource: AudioResource | null = null
  private failedTracks = 0
  private plays = 0

  private tasks: Promise<void> = Promise.resolve()
  private feedbackQueue: Promise<unknown> = Promise.resolve()
  private busy = false
  private destroyed = false
  private endReason: string | null = null
  // Яндекс отклонил токен владельца: волна заиграет снова, только когда он войдёт заново
  private rejectedToken = false
  private renderQueue: Promise<void> = Promise.resolve()
  private renderPending = false

  private emptySince: number | null = null
  private pausedSince: number | null = null
  private idleSince: number | null = null
  private voiceProblemSince: number | null = null

  private reconnecting = false
  // Когда бот заходил в канал заново: не чаще MAX_RECONNECTS раз за RECONNECT_WINDOW
  private reconnects: number[] = []

  // Адрес, с которого голосовой сервер получает звук бота в текущем соединении с ним
  private udpCheck: { networking: unknown; address: string | null; misses: number } | null = null
  private checkingUdp = false

  /**
   * Сессия поверх уже подключённого голосового соединения и отправленного сообщения.
   * В боте используйте WaveSession.create: он подключается к каналу и отправляет сообщение сам
   */
  constructor(options: WaveSessionOptions, connection: VoiceConnection, message: Message) {
    this.guild = options.voiceChannel.guild
    this.guildId = this.guild.id
    this.owner = options.owner
    this.choice = options.choice
    this.onDestroy = options.onDestroy
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings }
    this.log = logger.child(`guild ${this.guildId}`)
    this.connection = connection
    this.message = message

    this.player = createAudioPlayer({
      // Пока голосовое соединение переподключается, трек стоит на паузе, а не играет в пустоту
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    })
    this.player.on('stateChange', (oldState, newState) => this.onPlayerStateChange(oldState, newState))
    this.player.on('error', error => this.onPlayerError(error))
    connection.subscribe(this.player)

    connection.on('stateChange', (oldState, newState) => this.onConnectionStateChange(oldState, newState))
    connection.on('debug', message => this.onConnectionDebug(message))
    connection.on(VoiceConnectionStatus.Disconnected, () => void this.onDisconnected())
    connection.on(
      VoiceConnectionStatus.Destroyed,
      () => void this.destroy('Бот отключён от голосового канала.', 'warn')
    )
    connection.on('error', error => this.log.error('Ошибка соединения', error))

    this.activityTimer = setInterval(() => this.checkActivity(), this.timings.activityCheckInterval)
    this.udpCheckTimer = setInterval(() => void this.checkVoiceAddress(), this.timings.udpCheckInterval)
  }

  /**
   * Подключение к голосовому каналу и отправка сообщения с плеером
   */
  static async create(options: WaveSessionOptions): Promise<WaveSession> {
    const { voiceChannel, textChannel } = options
    const guildId = voiceChannel.guild.id
    const log = logger.child(`guild ${guildId}`)
    const { connectTimeout } = { ...DEFAULT_TIMINGS, ...options.timings }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      // Ради сообщений DAVE в логе, остальные отладочные сообщения не выводим
      debug: true
    })
    // С самого подключения: первые сообщения DAVE приходят раньше, чем появляется сессия
    connection.on('debug', message => logDaveMessage(log, message))

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, connectTimeout)
    } catch (error) {
      log.error('Не удалось подключиться к голосовому каналу', error)
      destroyConnection(connection)
      throw new UserFacingError('Не удалось подключиться к голосовому каналу. Попробуйте ещё раз.')
    }

    let message: Message
    try {
      message = await textChannel.send({
        embeds: [loadingEmbed(options.choice)],
        components: controlsRows({
          paused: false,
          hasTrack: false,
          hasPrevious: false,
          hasHistory: false,
          hasSettings: !isDefaultChoice(options.choice)
        })
      })
    } catch (error) {
      log.error('Не удалось отправить сообщение плеера', error)
      destroyConnection(connection)
      throw new UserFacingError('Не удалось отправить сообщение с плеером в этот канал. Проверьте права бота.')
    }

    return new WaveSession(options, connection, message)
  }

  get messageId(): string | null {
    return this.message?.id ?? null
  }

  get voiceChannelId(): string | null {
    return this.connection.joinConfig.channelId
  }

  get currentTrack(): IYandexTrack | null {
    return this.current?.item.track ?? null
  }

  get stopReason(): string | null {
    return this.endReason
  }

  get tokenRejected(): boolean {
    return this.rejectedToken
  }

  get waveChoice(): WaveChoice {
    return this.choice
  }

  /**
   * Сыгранные треки, кроме текущего, последний — первым. После ⏮️ сюда входят и треки, к которым вернёт ⏭️
   */
  get recentTracks(): IYandexTrack[] {
    return [...this.history, ...this.upcoming]
      .sort((a, b) => (b.lastPlay ?? 0) - (a.lastPlay ?? 0))
      .map(item => item.track)
  }

  /**
   * Запуск волны. Возвращает false, если воспроизведение не началось: причина будет в stopReason
   */
  async start(): Promise<boolean> {
    await this.run(() => this.advance('finished'))
    return !this.destroyed && this.current !== null
  }

  /**
   * Смена настроек на ходу: создаётся новая сессия волны, и сразу играет её первый трек.
   * Если новую волну получить не удалось, продолжает играть прежняя. Возвращает, сменились ли настройки
   */
  async retune(choice: WaveChoice): Promise<boolean> {
    let retuned = false

    await this.run(async () => {
      let radio: IWaveSession
      try {
        radio = await this.yandex.createWaveSession(this.owner.accessToken, waveSeeds(choice), this.recentTrackIds())
      } catch (error) {
        if (error instanceof YandexAuthError) {
          throw error
        }
        this.log.error('Не удалось получить волну с новыми настройками', error)
        return
      }

      const items = this.freshItems(radio.sessionId, radio)
      if (items.length === 0) {
        this.log.warn('Волна с новыми настройками не вернула новых треков')
        return
      }

      this.choice = choice
      this.adoptRadio(radio.sessionId)
      // Треки прежней волны больше не нужны, в том числе те, к которым вела ⏭️ после ⏮️
      this.queue.splice(0, this.queue.length, ...items)
      this.upcoming.length = 0
      this.log.info(`Настройки волны: ${describeChoice(choice) || 'по умолчанию'}`)

      retuned = true
      await this.advance('skip')
    })

    return retuned
  }

  async skip(): Promise<void> {
    await this.run(() => this.advance('skip'))
  }

  async previous(): Promise<'ok' | 'empty' | 'failed'> {
    let result: 'ok' | 'empty' | 'failed' = 'failed'

    await this.run(async () => {
      const previous = this.history.pop()
      if (!previous) {
        result = 'empty'
        return
      }

      const interrupted = this.current
      if (!(await this.play(previous))) {
        this.history.push(previous)
        return
      }

      if (interrupted) {
        this.upcoming.push(interrupted.item)
      }
      result = 'ok'
    })

    return result
  }

  /**
   * Выбор в «📜 Истории»: трек сразу играет, а текущий уходит в историю, как после ⏭️, и волна продолжается
   * как шла. Если трек не запустился, играет прежний. missing — трека уже нет среди сыгранных
   */
  async playFromHistory(trackId: string): Promise<'ok' | 'missing' | 'failed'> {
    let result: 'ok' | 'missing' | 'failed' = 'failed'

    await this.run(async () => {
      // Пока список был открыт, к треку могли вернуться кнопкой ⏮️
      if (this.current?.item.track.id === trackId) {
        result = 'ok'
        return
      }

      const played = [this.history, this.upcoming].find(items => items.some(item => item.track.id === trackId))
      if (!played) {
        result = 'missing'
        return
      }

      const index = played.findIndex(item => item.track.id === trackId)
      const [picked] = played.splice(index, 1)
      const interrupted = this.current
      if (!(await this.play(picked))) {
        played.splice(index, 0, picked)
        return
      }

      if (interrupted) {
        this.sendEndFeedback(interrupted, 'skip')
        this.remember(interrupted.item)
        // play() уже перерисовал плеер, а прерванного трека тогда ещё не было в истории
        this.render()
      }
      result = 'ok'
    })

    return result
  }

  pause(): boolean {
    if (this.destroyed) {
      return false
    }

    const paused = this.player.pause()
    // Перерисовываем и при неудаче, чтобы кнопка показала настоящее состояние плеера
    this.render()
    return paused
  }

  resume(): boolean {
    if (this.destroyed) {
      return false
    }

    const resumed = this.player.unpause()
    this.render()
    return resumed
  }

  /**
   * Остановка плеера и освобождение ресурсов. Повторные вызовы ничего не делают.
   * level — уровень записи в логе: обычная остановка — info, сбой — warn или error.
   * Промис завершается, когда сообщение плеера обновлено
   */
  destroy(reason: string, level: MessageLevel = 'info'): Promise<void> {
    if (this.destroyed) {
      return this.renderQueue
    }

    this.destroyed = true
    this.endReason = reason
    this.log[level](`Плеер остановлен: ${reason}`)

    clearInterval(this.activityTimer)
    clearInterval(this.udpCheckTimer)
    this.lifetime.abort()
    this.player.stop(true)
    destroyConnection(this.connection)
    this.onDestroy(this)
    this.render()

    return this.renderQueue
  }

  /**
   * Все переключения треков выполняются по одному, чтобы нажатия кнопок и события плеера не мешали друг другу
   */
  private run(task: () => Promise<void>): Promise<void> {
    const next = this.tasks.then(async () => {
      if (this.destroyed) {
        return
      }

      this.busy = true
      try {
        await task()
      } catch (error) {
        if (error instanceof YandexAuthError) {
          this.rejectedToken = true
          void this.destroy(
            'Токен Яндекса владельца плеера недействителен или истёк. Владельцу нужно войти заново командой `/login`.',
            'warn'
          )
        } else {
          this.log.error('Ошибка плеера', error)
          void this.destroy('Произошла ошибка плеера.', 'error')
        }
      } finally {
        this.busy = false
      }
    })

    this.tasks = next
    return next
  }

  /**
   * Завершение текущего трека и запуск следующего
   */
  private async advance(reason: EndReason): Promise<void> {
    const ended = this.current
    if (ended) {
      this.sendEndFeedback(ended, reason)
      this.remember(ended.item)
      this.current = null
    }
    this.failedTracks = reason === 'error' ? this.failedTracks + 1 : 0

    if (reason === 'skip') {
      // Нажатие ⏭️ должно ощущаться сразу: глушим трек и показываем загрузку, пока получаем следующий
      this.player.stop(true)
      this.render()
    }

    while (!this.destroyed) {
      if (this.failedTracks >= MAX_FAILED_TRACKS) {
        void this.destroy('Не удалось воспроизвести несколько треков подряд.', 'error')
        return
      }

      const next = await this.takeNext()
      if (this.destroyed) {
        return
      }
      if (!next) {
        void this.destroy('Не удалось загрузить треки «Моей волны».', 'error')
        return
      }
      if (await this.play(next)) {
        return
      }
      this.failedTracks++
    }
  }

  private async play(item: QueueItem, attempt = 1): Promise<boolean> {
    const stream = await this.yandex.openTrackStream(this.owner.accessToken, item.track.id)
    if (!stream || this.destroyed) {
      if (stream) {
        discard(stream)
      }
      return false
    }

    // Плеер закрывает поток при смене трека и остановке, вместе с ним завершается ffmpeg и обрывается загрузка файла
    const resource = createTrackResource(stream)
    resource.volume?.setVolume(VOLUME)

    item.lastPlay = ++this.plays
    this.current = { item, resource, attempt }
    this.failedResource = null
    this.player.play(resource)
    this.log.info(`Воспроизведение: ${formatTrack(item.track)}`)
    this.render()

    return true
  }

  private async takeNext(): Promise<QueueItem | null> {
    const upcoming = this.upcoming.pop()
    if (upcoming) {
      return upcoming
    }

    if (this.queue.length === 0) {
      await this.loadBatch()
    }
    return this.queue.shift() ?? null
  }

  /**
   * Загрузка следующей партии треков. Волне передаются последние сыгранные треки, чтобы она продолжилась, а не началась заново
   */
  private async loadBatch(): Promise<void> {
    let queue = this.recentTrackIds()

    for (let attempt = 1; attempt <= BATCH_ATTEMPTS && !this.destroyed; attempt++) {
      try {
        const { sessionId, batch } = await this.fetchBatch(queue)
        const items = this.freshItems(sessionId, batch)

        this.queue.push(...items)
        if (items.length > 0) {
          return
        }

        // Волна вернула только недавние треки: просим продолжение после них
        queue = [...queue, ...batch.tracks.map(track => YandexMusicService.fullTrackId(track))]
      } catch (error) {
        if (error instanceof YandexAuthError) {
          throw error
        }
        this.log.warn(`Не удалось загрузить треки волны (попытка ${attempt}/${BATCH_ATTEMPTS})`, error)
      }

      if (attempt < BATCH_ATTEMPTS) {
        await sleep(attempt * this.timings.retryDelay)
      }
    }
  }

  /**
   * Партия из текущей сессии волны. Если сессии ещё нет или Яндекс Музыка её завершила,
   * создаётся новая с теми же настройками
   */
  private async fetchBatch(queue: string[]): Promise<{ sessionId: string; batch: IStationBatch }> {
    if (this.radioSessionId) {
      const sessionId = this.radioSessionId
      const batch = await this.yandex.getWaveTracks(this.owner.accessToken, sessionId, queue)
      if (batch) {
        return { sessionId, batch }
      }

      this.log.info('Яндекс Музыка завершила сессию волны, создаём новую')
      this.radioSessionId = null
    }

    const radio = await this.yandex.createWaveSession(this.owner.accessToken, waveSeeds(this.choice), queue)
    this.adoptRadio(radio.sessionId)
    return { sessionId: radio.sessionId, batch: radio }
  }

  /**
   * Новая сессия волны становится текущей: следующие партии запрашиваются у неё
   */
  private adoptRadio(sessionId: string): void {
    this.radioSessionId = sessionId
    this.sendFeedback(sessionId, { type: 'radioStarted' })
  }

  /**
   * Треки партии без недавно сыгранных: волна иногда повторяет только что игравшие
   */
  private freshItems(sessionId: string, batch: IStationBatch): QueueItem[] {
    const recent = new Set(this.history.map(item => item.track.id))
    if (this.current) {
      recent.add(this.current.item.track.id)
    }

    return batch.tracks
      .filter(track => !recent.has(track.id))
      .map(track => ({ track, sessionId, batchId: batch.batchId, feedback: 'pending' as const }))
  }

  /**
   * Последние сыгранные треки для параметра queue: волна продолжится после них и не повторит их
   */
  private recentTrackIds(): string[] {
    const played = this.current ? [...this.history, this.current.item] : this.history
    return played.slice(-RECENT_QUEUE_SIZE).map(item => YandexMusicService.fullTrackId(item.track))
  }

  private remember(item: QueueItem): void {
    this.history.push(item)
    if (this.history.length > HISTORY_SIZE) {
      this.history.shift()
    }
  }

  private onPlayerStateChange(oldState: AudioPlayerState, newState: AudioPlayerState): void {
    if (this.destroyed) {
      return
    }

    if (newState.status === AudioPlayerStatus.Playing && oldState.status !== AudioPlayerStatus.Playing) {
      const playback = this.current
      if (playback && newState.resource === playback.resource && playback.item.feedback === 'pending') {
        setTimeout(() => {
          if (!this.destroyed && this.current === playback) {
            this.confirmStarted(playback)
          }
        }, this.timings.startConfirmDelay)
      }
      return
    }

    if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
      const resource = oldState.resource
      void this.run(() => this.onTrackEnded(resource))
    }
  }

  private onPlayerError(error: AudioPlayerError): void {
    // Сразу после ошибки плеер перейдёт в Idle, там и решаем, повторять ли трек
    this.failedResource = error.resource
    this.log.error('Ошибка воспроизведения', error)
  }

  /**
   * Фидбэк о начале трека отправляется, только если звук действительно пошёл
   */
  private confirmStarted(playback: Playback): void {
    const { item, resource } = playback
    if (item.feedback !== 'pending' || resource.playbackDuration === 0) {
      return
    }

    item.feedback = 'started'
    const trackId = YandexMusicService.fullTrackId(item.track)
    this.sendFeedback(item.sessionId, { type: 'trackStarted', trackId, batchId: item.batchId })
  }

  private async onTrackEnded(resource: AudioResource): Promise<void> {
    const playback = this.current
    // Трек уже заменён другим (⏭️, ⏮️ или повтор)
    if (!playback || playback.resource !== resource) {
      return
    }

    const { retryWindow } = this.timings
    const endedTooEarly = resource.playbackDuration < retryWindow && (playback.item.track.durationMs ?? 0) > retryWindow
    if (this.failedResource !== resource && !endedTooEarly) {
      await this.advance('finished')
      return
    }

    if (resource.playbackDuration < retryWindow && playback.attempt < MAX_TRACK_ATTEMPTS) {
      this.log.warn(
        `Поток прервался, повторная попытка ${playback.attempt + 1}/${MAX_TRACK_ATTEMPTS}: ${formatTrack(playback.item.track)}`
      )
      await sleep(this.timings.retryDelay)
      if (this.destroyed || (await this.play(playback.item, playback.attempt + 1))) {
        return
      }
    }

    await this.advance('error')
  }

  private sendEndFeedback(playback: Playback, reason: EndReason): void {
    // Трек могли пропустить раньше, чем сработала отложенная проверка старта
    this.confirmStarted(playback)

    const { item, resource } = playback
    if (item.feedback !== 'started') {
      return
    }

    item.feedback = 'done'
    this.sendFeedback(item.sessionId, {
      type: reason === 'skip' ? 'skip' : 'trackFinished',
      trackId: YandexMusicService.fullTrackId(item.track),
      batchId: item.batchId,
      totalPlayedSeconds: resource.playbackDuration / 1000
    })
  }

  /**
   * Фидбэк отправляется строго по очереди, чтобы волна получала события в правильном порядке
   */
  private sendFeedback(sessionId: string, feedback: WaveFeedback): void {
    this.feedbackQueue = this.feedbackQueue.then(() =>
      this.yandex.sendWaveFeedback(this.owner.accessToken, sessionId, feedback)
    )
  }

  private onConnectionStateChange(oldState: VoiceConnectionState, newState: VoiceConnectionState): void {
    // Остановку плеера в логе уже видно по «Плеер остановлен»
    if (oldState.status !== newState.status && newState.status !== VoiceConnectionStatus.Destroyed) {
      this.log.info(`Голосовое соединение: ${oldState.status} -> ${describeConnectionState(newState)}`)
    }

    // При обрыве веб-сокета голосовой сервер исключает бота из группы сквозного шифрования (DAVE), а @discordjs/voice 0.19
    // возобновляет соединение, не возвращая бота в группу: плеер играет, но расшифровать звук бота никто не может
    if (isResuming(oldState, newState)) {
      this.reconnectSoon('оборвалась связь с голосовым сервером')
    }
  }

  private onConnectionDebug(message: string): void {
    // Пока бот не в группе шифрования, смены ключей между остальными участниками его не касаются
    if (isMissedTransition(message) && isDaveActive(this.connection)) {
      this.reconnectSoon('пропущена смена ключей сквозного шифрования (DAVE)')
    }
  }

  /**
   * Переподключение после текущего события соединения: оно само меняет состояние соединения
   */
  private reconnectSoon(reason: string): void {
    queueMicrotask(() => void this.reconnect(reason))
  }

  /**
   * Бот заходит в канал заново, как после ⏹️ и /my-wave, но с тем же треком и очередью: пока соединения нет,
   * плеер на паузе, а потом продолжает трек с того же места
   */
  private async reconnect(reason: string): Promise<void> {
    if (this.destroyed || this.reconnecting) {
      return
    }

    const now = Date.now()
    this.reconnects = this.reconnects.filter(time => now - time < RECONNECT_WINDOW)
    if (this.reconnects.length >= MAX_RECONNECTS) {
      void this.destroy('Соединение с голосовым каналом постоянно обрывается.', 'error')
      return
    }

    const { channelId, selfDeaf, selfMute } = this.connection.joinConfig
    if (!channelId) {
      void this.destroy('Соединение с голосовым каналом потеряно.', 'warn')
      return
    }

    this.reconnects.push(now)
    this.reconnecting = true
    this.log.warn(`Заходим в голосовой канал заново: ${reason}`)
    try {
      // Если маршрут VPN умер, вместе с голосовым соединением завис и шлюз Discord: запрос на вход в канал теряется
      // или не уходит, пока шлюз не переподключится. Поэтому пробуем снова, пока не выйдет время
      const deadline = now + this.timings.voiceRecoveryTimeout
      for (let attempt = 1; !(await this.tryRejoin({ channelId, selfDeaf, selfMute })); attempt++) {
        if (this.destroyed) {
          return
        }
        if (Date.now() >= deadline) {
          this.log.error(`Не удалось зайти в голосовой канал заново, попыток: ${attempt}`)
          void this.destroy('Соединение с голосовым каналом потеряно.', 'error')
          return
        }

        this.log.warn(`Не удалось зайти в голосовой канал (попытка ${attempt}), пробуем снова`)
        await sleep(this.timings.rejoinDelay, undefined, { signal: this.lifetime.signal })
      }
      this.log.info('Голосовое соединение восстановлено')
    } catch (error) {
      // Пауза между попытками прерывается, когда плеер останавливают
      if (!this.destroyed) {
        this.log.error('Ошибка при входе в голосовой канал заново', error)
        void this.destroy('Соединение с голосовым каналом потеряно.', 'error')
      }
    } finally {
      this.reconnecting = false
      this.voiceProblemSince = null
    }
  }

  /**
   * Одна попытка выйти из канала и зайти снова. true — соединение готово
   */
  private async tryRejoin(config: { channelId: string; selfDeaf: boolean; selfMute: boolean }): Promise<boolean> {
    // disconnect() закрывает соединение с голосовым сервером, а в Signalling его ещё нет, и disconnect() ничего не делает:
    // тогда только выходим из канала. Заодно disconnect() отписывает плеер от соединения, поэтому подписываем его снова
    if (!this.connection.disconnect()) {
      this.connection.rejoin({ ...config, channelId: null })
    }
    // Шлюз Discord переподключается, и запрос не отправлен
    if (!this.connection.rejoin(config)) {
      return false
    }
    this.connection.subscribe(this.player)

    try {
      const timeout = AbortSignal.timeout(this.timings.connectTimeout)
      await entersState(this.connection, VoiceConnectionStatus.Ready, AbortSignal.any([this.lifetime.signal, timeout]))
      return true
    } catch {
      return false
    }
  }

  private async onDisconnected(): Promise<void> {
    // Бот сам вышел из канала, чтобы зайти заново
    if (this.reconnecting) {
      return
    }

    try {
      // Переподключение (например, бота перенесли в другой канал) начнётся само, если это не окончательное отключение
      await Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling, this.timings.reconnectTimeout),
        entersState(this.connection, VoiceConnectionStatus.Connecting, this.timings.reconnectTimeout)
      ])
      this.log.info('Соединение восстанавливается...')
    } catch {
      void this.destroy('Соединение с голосовым каналом потеряно.', 'warn')
    }
  }

  private checkActivity(): void {
    if (this.destroyed) {
      return
    }

    const now = Date.now()
    const { emptyChannelTimeout, pauseTimeout, noPlaybackTimeout, voiceStallTimeout, heartbeatTimeout } = this.timings

    const listeners = this.countListeners()
    this.emptySince = listeners === 0 ? (this.emptySince ?? now) : null
    if (this.emptySince !== null && now - this.emptySince >= emptyChannelTimeout) {
      void this.destroy('Все пользователи покинули голосовой канал.')
      return
    }

    const status = this.player.state.status
    this.pausedSince = status === AudioPlayerStatus.Paused ? (this.pausedSince ?? now) : null
    if (this.pausedSince !== null && now - this.pausedSince >= pauseTimeout) {
      void this.destroy(`Пауза длилась дольше ${Math.round(pauseTimeout / 60_000)} минут.`)
      return
    }

    this.idleSince = status === AudioPlayerStatus.Idle && !this.busy ? (this.idleSince ?? now) : null
    if (this.idleSince !== null && now - this.idleSince >= noPlaybackTimeout) {
      void this.destroy('Нет активного воспроизведения музыки.', 'warn')
      return
    }

    // Голосовой сервер не ответил на heartbeat: соединение зависло, например на умершем маршруте VPN.
    // @discordjs/voice закроет его только после трёх пропущенных heartbeat, почти через минуту тишины
    if (listeners && !this.reconnecting && isVoiceSocketStalled(this.connection, heartbeatTimeout, now)) {
      void this.reconnect(`голосовой сервер не отвечает на heartbeat дольше ${heartbeatTimeout / 1000} с`)
      return
    }

    // Плеер может играть, когда бота не слышно: соединение не восстанавливается или не готово шифрование
    const problem = listeners && !this.reconnecting ? voiceProblem(this.connection) : null
    this.voiceProblemSince = problem ? (this.voiceProblemSince ?? now) : null
    if (problem && this.voiceProblemSince !== null && now - this.voiceProblemSince >= voiceStallTimeout) {
      void this.reconnect(problem)
    }
  }

  /**
   * Сверка адреса, с которого голосовой сервер получает звук бота. Если UDP-туннель VPN перестроился через другой
   * сервер, а веб-сокет голосового соединения остался жив, адрес меняется, и бот заходит в канал заново: иначе Discord
   * мог бы отбрасывать его звук, и никто бы этого не заметил. Если сервер на проверку не отвечает, она отключается
   * до следующего соединения с ним
   */
  private async checkVoiceAddress(): Promise<void> {
    const { state } = this.connection
    if (this.destroyed || this.reconnecting || this.checkingUdp || state.status !== VoiceConnectionStatus.Ready) {
      return
    }

    // Новое соединение с голосовым сервером: адрес в нём узнаём заново
    const { networking } = state
    if (this.udpCheck?.networking !== networking) {
      this.udpCheck = { networking, address: null, misses: 0 }
    }
    const check = this.udpCheck
    if (!check.address && check.misses >= UDP_CHECK_ATTEMPTS) {
      return
    }

    this.checkingUdp = true
    try {
      const address = await discoverVoiceAddress(this.connection, this.timings.udpCheckTimeout)
      // Пока ждали ответа, соединение могли пересоздать
      if (this.destroyed || this.reconnecting || this.udpCheck !== check) {
        return
      }

      if (!address) {
        check.misses++
        if (!check.address && check.misses === UDP_CHECK_ATTEMPTS) {
          this.log.info('Проверка UDP: голосовой сервер не отвечает, до следующего соединения проверка отключена')
        }
        return
      }

      check.misses = 0
      if (!check.address) {
        check.address = address
        this.log.info(`Проверка UDP: голосовой сервер получает звук бота с адреса ${address}`)
      } else if (address !== check.address) {
        void this.reconnect(`звук бота стал приходить в Discord с другого адреса (${check.address} -> ${address})`)
      }
    } finally {
      this.checkingUdp = false
    }
  }

  /**
   * Количество слушателей (не ботов) в голосовом канале бота; null, если канал неизвестен
   */
  private countListeners(): number | null {
    const channelId = this.connection.joinConfig.channelId
    if (!channelId) {
      return null
    }

    const botId = this.guild.client.user.id
    return this.guild.voiceStates.cache.filter(
      state => state.channelId === channelId && state.id !== botId && !state.member?.user.bot
    ).size
  }

  /**
   * Обновления сообщения выполняются по очереди и склеиваются: показывается актуальное состояние плеера
   */
  private render(): void {
    if (this.renderPending) {
      return
    }

    this.renderPending = true
    this.renderQueue = this.renderQueue.then(async () => {
      this.renderPending = false
      await this.editMessage(this.buildMessage())
    })
  }

  private buildMessage(): MessageEditOptions {
    if (this.destroyed) {
      return { embeds: [stoppedEmbed(this.endReason ?? 'Плеер был остановлен.')], components: [] }
    }

    const track = this.current?.item.track
    const controls = controlsRows({
      paused: this.player.state.status === AudioPlayerStatus.Paused,
      hasTrack: !!track,
      hasPrevious: this.history.length > 0,
      hasHistory: this.history.length + this.upcoming.length > 0,
      hasSettings: !isDefaultChoice(this.choice)
    })
    return {
      embeds: [track ? nowPlayingEmbed(track, this.choice) : loadingEmbed(this.choice)],
      components: controls
    }
  }

  private async editMessage(options: MessageEditOptions): Promise<void> {
    if (!this.message) {
      return
    }

    try {
      await this.message.edit(options)
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) {
        this.message = null
        return
      }
      this.log.error('Не удалось обновить сообщение плеера', error)
    }
  }
}

/**
 * Embed остановленного плеера
 */
export function stoppedEmbed(reason: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOR_STOPPED)
    .setTitle('⏹️ Воспроизведение остановлено')
    .setDescription(`${reason}\n\nЧтобы запустить волну снова, используйте \`/my-wave\`.`)
    .setFooter({ text: FOOTER })
    .setTimestamp()
}

function loadingEmbed(choice: WaveChoice): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOR_PLAYING)
    .setTitle('🎵 Сейчас играет')
    .setDescription(`Загрузка трека...${waveLine(choice)}`)
    .setFooter({ text: FOOTER })
    .setTimestamp()
}

function nowPlayingEmbed(track: IYandexTrack, choice: WaveChoice): EmbedBuilder {
  const album = track.albums[0]?.title || 'Неизвестный альбом'
  const embed = new EmbedBuilder()
    .setColor(COLOR_PLAYING)
    .setTitle('🎵 Сейчас играет')
    .setDescription(
      `**${escapeMarkdown(track.title)}**\nИсполнитель: ${escapeMarkdown(formatArtists(track))}\nАльбом: ${escapeMarkdown(album)}${waveLine(choice)}`
    )
    .setFooter({ text: FOOTER })
    .setTimestamp()

  if (track.coverUri) {
    embed.setThumbnail(`https://${track.coverUri.replace('%%', '400x400')}`)
  }
  return embed
}

/**
 * Строка с настройками волны, если хоть одна отличается от «Любое»
 */
function waveLine(choice: WaveChoice): string {
  const description = describeChoice(choice)
  return description ? `\nВолна: ${escapeMarkdown(description)}` : ''
}

interface ControlsState {
  paused: boolean
  hasTrack: boolean
  hasPrevious: boolean
  // Есть сыгранные треки: после ⏮️ это и треки, к которым вернёт ⏭️
  hasHistory: boolean
  // Играет подборка или не «Любое» в какой-то группе: тогда настройки можно сбросить
  hasSettings: boolean
}

/**
 * Кнопки плеера. Недоступные сейчас действия выключены, чтобы не объяснять их сообщениями.
 * В ряду помещается не больше пяти кнопок, поэтому история и настройки волны во втором ряду.
 * Кнопка сброса появляется, только когда сбрасывать есть что
 */
function controlsRows({
  paused,
  hasTrack,
  hasPrevious,
  hasHistory,
  hasSettings
}: ControlsState): ActionRowBuilder<ButtonBuilder>[] {
  const waveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    controlButton('history', '📜 История').setDisabled(!hasHistory),
    controlButton('settings', '⚙️ Настроить волну'),
    controlButton('carousel', '🎡 Подборки')
  )
  if (hasSettings) {
    waveRow.addComponents(controlButton('reset', '↩️ Сбросить настройки'))
  }

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      controlButton('like', '👍').setDisabled(!hasTrack),
      controlButton('previous', '⏮️').setDisabled(!hasPrevious),
      paused ? controlButton('resume', '▶️') : controlButton('pause', '⏸️').setDisabled(!hasTrack),
      controlButton('stop', '⏹️'),
      controlButton('next', '⏭️')
    ),
    waveRow
  ]
}

function controlButton(action: WaveAction, label: string): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${WAVE_BUTTON_PREFIX}${action}`)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary)
}

function formatArtists(track: IYandexTrack): string {
  return track.artists.map(artist => artist.name).join(', ') || 'Неизвестный исполнитель'
}

function formatTrack(track: IYandexTrack): string {
  return `${formatArtists(track)} — ${track.title}`
}

function destroyConnection(connection: VoiceConnection): void {
  if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
    connection.destroy()
  }
}
