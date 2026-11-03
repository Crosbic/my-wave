import crypto from 'crypto'
import { setTimeout as sleep } from 'timers/promises'

import axios, { AxiosInstance, InternalAxiosRequestConfig, isAxiosError } from 'axios'

import { YandexAuthError } from '../errors/yandexAuthError.js'
import { IUserData } from '../types/userData.js'
import { WaveSettingGroup, WaveSettingKey } from '../types/waveSettings.js'
import { IStationBatch, IWaveSession, IYandexTrack } from '../types/yandexTrack.js'
import { logger } from '../utils/logger.js'

import type { components, operations } from '../types/yandex-api.js'

const API_URL = 'https://api.music.yandex.net'
const REQUEST_TIMEOUT = 15_000
// Отказ 429 («Concurrency limit exceeded») кратковременный: через секунду-две тот же запрос проходит
const RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_DELAY = 1_000
const MAX_RATE_LIMIT_DELAY = 5_000

// Соль для подписи прямой ссылки на файл, как в эталонном клиенте MarshalX/yandex-music-api
const SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA'
const FEEDBACK_FROM = 'ym-player-bot'

// Занятия приходят списком станций без названия группы, а у «Любого» нет значения в ответе API
const ACTIVITY_GROUP_NAME = 'Под занятие'
const ANY_VALUE_NAME = 'Любое'
const RESTRICTION_KEYS = ['diversity', 'moodEnergy', 'language'] as const

const log = logger.child('yandex')

// Типы запросов и ответов сгенерированы из спецификации API (yarn api:generate):
// опечатка в имени параметра или поля запроса не скомпилируется
type ApiTrack = components['schemas']['Track']
type SequenceItem = components['schemas']['SequenceItem']
type DownloadVariant = components['schemas']['TrackDownloadInfo']
type AccountStatusResponse = operations['getAccountStatus']['responses'][200]['content']['application/json']
type DownloadInfoResponse = operations['getDownloadInfo']['responses'][200]['content']['application/json']
type LikeTracksForm = operations['likeTracks']['requestBody']['content']['application/x-www-form-urlencoded']

// Сессий волны и её настроек в спецификации нет. Форматы взяты из запросов веб-клиента Яндекс Музыки
interface WaveSessionBody {
  seeds: string[]
  queue?: string[]
  includeTracksInResponse: boolean
  includeWaveModel: boolean
  interactive: boolean
}

interface WaveTracksBody {
  queue: string[]
}

interface WaveFeedbackBody {
  event: {
    type: WaveFeedback['type']
    timestamp: string
    from?: string
    trackId?: string
    totalPlayedSeconds?: number
  }
  batchId?: string
  from: string
}

interface ApiWaveBatch {
  batchId?: string
  sequence?: SequenceItem[]
}

interface ApiWaveSession extends ApiWaveBatch {
  radioSessionId: string
}

interface ApiWaveTracks extends ApiWaveBatch {
  terminated?: boolean
  unknownSession?: boolean
}

interface ApiWaveValue {
  value: string
  name: string
  serializedSeed?: string
  unspecified?: boolean
}

interface ApiWaveSettings {
  blocks?: { type: string; items?: { id: { type: string; tag: string }; name: string }[] }[]
  settingRestrictions?: Partial<
    Record<Exclude<WaveSettingKey, 'activity'>, { name: string; possibleValues?: ApiWaveValue[] }>
  >
}

// Ответы, которых нет в спецификации
interface ILoginInfo {
  id: string
  login?: string
  display_name?: string
  real_name?: string
  first_name?: string
  last_name?: string
  default_avatar_id?: string
}

interface IDirectLinkInfo {
  host?: string
  path?: string
  ts?: string
  s?: string
}

/**
 * Фидбэк сессии волны. У radioStarted нет трека и batchId
 */
export type WaveFeedback =
  | { type: 'radioStarted' }
  | { type: 'trackStarted'; trackId: string; batchId: string | null }
  | { type: 'trackFinished' | 'skip'; trackId: string; batchId: string | null; totalPlayedSeconds: number }

export class YandexMusicService {
  private static instance: YandexMusicService
  // Названия настроек волны приходят на языке из Accept-Language
  private readonly http = axios.create({
    baseURL: API_URL,
    timeout: REQUEST_TIMEOUT,
    headers: { 'Accept-Language': 'ru' }
  })

  private constructor() {
    retryOnRateLimit(this.http)
  }

  public static getInstance(): YandexMusicService {
    if (!YandexMusicService.instance) {
      YandexMusicService.instance = new YandexMusicService()
    }
    return YandexMusicService.instance
  }

  /**
   * Идентификатор трека в формате «трек:альбом», который ждут фидбэк волны, параметр queue и лайки
   */
  public static fullTrackId(track: IYandexTrack): string {
    const albumId = track.albums[0]?.id
    return albumId ? `${track.id}:${albumId}` : track.id
  }

  /**
   * Получение информации о пользователе и его подписке
   */
  public async getUserInfo(token: string): Promise<{ userInfo: IUserData; hasPlus: boolean }> {
    try {
      const [statusResponse, userResponse] = await Promise.all([
        this.http.get<AccountStatusResponse>('/account/status', { headers: this.authHeaders(token) }),
        axios.get<ILoginInfo>('https://login.yandex.ru/info', {
          params: { format: 'json' },
          headers: this.authHeaders(token),
          timeout: REQUEST_TIMEOUT
        })
      ])

      const user = userResponse.data
      const hasPlus = !!statusResponse.data.result?.plus?.hasPlus

      return {
        userInfo: {
          id: String(user.id),
          fullName: user.real_name || '',
          firstName: user.first_name || '',
          lastName: user.last_name || '',
          nickName: user.display_name || user.login || '',
          avatarUrl: user.default_avatar_id || '',
          hasPlus
        },
        hasPlus
      }
    } catch (error) {
      throw this.wrapError(error)
    }
  }

  /**
   * Настройки «Моей волны»: занятия и значения характера, настроения и языка
   */
  public async getWaveSettings(token: string): Promise<WaveSettingGroup[]> {
    try {
      const response = await this.http.get<{ result: ApiWaveSettings }>('/rotor/wave/settings', {
        headers: this.authHeaders(token)
      })
      return this.toWaveSettingGroups(response.data.result)
    } catch (error) {
      throw this.wrapError(error)
    }
  }

  /**
   * Новая сессия волны с первой партией треков. Сиды задают волну и её настройки.
   * queue — последние сыгранные треки: волна продолжит после них и не повторит их
   */
  public async createWaveSession(token: string, seeds: string[], queue: string[] = []): Promise<IWaveSession> {
    const body: WaveSessionBody = {
      seeds,
      ...(queue.length > 0 && { queue }),
      includeTracksInResponse: true,
      includeWaveModel: true,
      interactive: true
    }

    try {
      const response = await this.http.post<{ result: ApiWaveSession }>('/rotor/session/new', body, {
        headers: this.authHeaders(token)
      })
      const { radioSessionId, ...batch } = response.data.result
      return { sessionId: radioSessionId, ...this.toBatch(batch) }
    } catch (error) {
      throw this.wrapError(error)
    }
  }

  /**
   * Следующая партия треков сессии волны. null — Яндекс Музыка завершила сессию или не знает её, нужна новая
   */
  public async getWaveTracks(token: string, sessionId: string, queue: string[]): Promise<IStationBatch | null> {
    const body: WaveTracksBody = { queue }

    try {
      const response = await this.http.post<{ result: ApiWaveTracks }>(
        `/rotor/session/${encodeURIComponent(sessionId)}/tracks`,
        body,
        { headers: this.authHeaders(token) }
      )
      const result = response.data.result
      return result.unknownSession || result.terminated ? null : this.toBatch(result)
    } catch (error) {
      throw this.wrapError(error)
    }
  }

  /**
   * Отправка фидбэка сессии волны. Ошибки только логируются: фидбэк не должен мешать воспроизведению
   */
  public async sendWaveFeedback(token: string, sessionId: string, feedback: WaveFeedback): Promise<boolean> {
    const body: WaveFeedbackBody = {
      event: { type: feedback.type, timestamp: new Date().toISOString() },
      from: FEEDBACK_FROM
    }

    if (feedback.type === 'radioStarted') {
      body.event.from = FEEDBACK_FROM
    } else {
      body.event.trackId = feedback.trackId
      if (feedback.type !== 'trackStarted') {
        body.event.totalPlayedSeconds = feedback.totalPlayedSeconds
      }
      if (feedback.batchId) {
        body.batchId = feedback.batchId
      }
    }

    try {
      await this.http.post(`/rotor/session/${encodeURIComponent(sessionId)}/feedback`, body, {
        headers: this.authHeaders(token)
      })
      return true
    } catch (error) {
      log.warn(`Не удалось отправить фидбэк ${feedback.type} сессии волны`, error)
      return false
    }
  }

  /**
   * Получение прямой ссылки на аудиофайл трека. Ссылка на download-info живёт около минуты,
   * поэтому получать её нужно непосредственно перед воспроизведением
   */
  public async getStreamUrl(token: string, trackId: string): Promise<string | null> {
    try {
      const infoResponse = await this.http.get<DownloadInfoResponse>(`/tracks/${trackId}/download-info`, {
        headers: this.authHeaders(token)
      })
      const variant = this.pickDownloadVariant(infoResponse.data.result ?? [])
      if (!variant) {
        log.warn(`Для трека ${trackId} нет доступных вариантов загрузки`)
        return null
      }

      const linkResponse = await this.http.get<IDirectLinkInfo>(variant.downloadInfoUrl, {
        headers: this.authHeaders(token),
        params: { format: 'json' }
      })
      const { host, path, ts, s } = linkResponse.data ?? {}
      if (!host || !path || !ts || !s) {
        log.warn(`Не удалось получить данные для загрузки трека ${trackId}`)
        return null
      }

      const sign = crypto
        .createHash('md5')
        .update(SIGN_SALT + path.slice(1) + s)
        .digest('hex')

      return `https://${host}/get-mp3/${sign}/${ts}${path}`
    } catch (error) {
      const wrapped = this.wrapError(error)
      if (wrapped instanceof YandexAuthError) {
        throw wrapped
      }
      log.error(`Не удалось получить ссылку на трек ${trackId}`, error)
      return null
    }
  }

  /**
   * Добавление трека в «Мне нравится»
   */
  public async likeTrack(token: string, userId: string, trackId: string): Promise<boolean> {
    const form: LikeTracksForm = { 'track-ids': [trackId] }

    try {
      await this.http.post(`/users/${userId}/likes/tracks/add-multiple`, toFormBody(form), {
        headers: this.authHeaders(token)
      })
      return true
    } catch (error) {
      const wrapped = this.wrapError(error)
      if (wrapped instanceof YandexAuthError) {
        throw wrapped
      }
      log.error(`Не удалось добавить трек ${trackId} в «Мне нравится»`, error)
      return false
    }
  }

  /**
   * Лучший вариант загрузки: полная версия, mp3, максимальный битрейт
   */
  private pickDownloadVariant(variants: DownloadVariant[]): DownloadVariant | undefined {
    const isPreview = (variant: DownloadVariant) => {
      // В спецификации preview описан строкой, но API отдаёт boolean
      const preview: unknown = variant.preview
      return preview === true || preview === 'true'
    }

    return [...variants].sort(
      (a, b) =>
        Number(isPreview(a)) - Number(isPreview(b)) ||
        Number(a.codec !== 'mp3') - Number(b.codec !== 'mp3') ||
        b.bitrateInKbps - a.bitrateInKbps
    )[0]
  }

  private toBatch({ batchId, sequence }: ApiWaveBatch): IStationBatch {
    const tracks = (sequence ?? [])
      .map(item => item.track)
      .filter(track => track && track.available)
      .map(track => this.toTrack(track))

    return { batchId: batchId ?? null, tracks }
  }

  /**
   * Группы настроек в порядке приложения: занятие, характер, настроение, язык.
   * «Любое» (unspecified) сидом не передаётся, от него остаётся только название
   */
  private toWaveSettingGroups(settings: ApiWaveSettings): WaveSettingGroup[] {
    const groups: WaveSettingGroup[] = []

    const contexts = settings.blocks?.find(block => block.type === 'contexts')?.items ?? []
    if (contexts.length > 0) {
      groups.push({
        key: 'activity',
        name: ACTIVITY_GROUP_NAME,
        anyName: ANY_VALUE_NAME,
        options: contexts.map(item => ({ seed: `${item.id.type}:${item.id.tag}`, name: item.name }))
      })
    }

    for (const key of RESTRICTION_KEYS) {
      const restriction = settings.settingRestrictions?.[key]
      const values = restriction?.possibleValues ?? []
      const options = values.flatMap(value =>
        !value.unspecified && value.serializedSeed ? [{ seed: value.serializedSeed, name: value.name }] : []
      )

      if (restriction && options.length > 0) {
        groups.push({
          key,
          name: restriction.name,
          anyName: values.find(value => value.unspecified)?.name ?? ANY_VALUE_NAME,
          options
        })
      }
    }

    return groups
  }

  private toTrack(track: ApiTrack): IYandexTrack {
    return {
      id: String(track.id),
      title: track.title,
      artists: (track.artists ?? []).map(artist => ({ name: artist.name })),
      albums: (track.albums ?? []).map(album => ({ id: album.id, title: album.title ?? '' })),
      coverUri: track.coverUri ?? '',
      durationMs: track.durationMs
    }
  }

  private authHeaders(token: string) {
    return { Authorization: `OAuth ${token}` }
  }

  private wrapError(error: unknown): unknown {
    if (isAxiosError(error) && error.response?.status === 401) {
      return new YandexAuthError()
    }
    return error
  }
}

type RateLimitedConfig = InternalAxiosRequestConfig & { rateLimitAttempt?: number }

/**
 * Повтор запросов, на которые Яндекс Музыка ответила 429. Пауза растёт с каждой попыткой,
 * а если API прислал Retry-After, берётся она (но не дольше MAX_RATE_LIMIT_DELAY)
 */
export function retryOnRateLimit(
  http: AxiosInstance,
  { retries = RATE_LIMIT_RETRIES, delay = RATE_LIMIT_DELAY } = {}
): void {
  http.interceptors.response.use(undefined, async (error: unknown) => {
    const config = isAxiosError(error) ? (error.config as RateLimitedConfig | undefined) : undefined
    if (!isAxiosError(error) || error.response?.status !== 429 || !config) {
      throw error
    }

    const attempt = (config.rateLimitAttempt ?? 0) + 1
    if (attempt > retries) {
      throw error
    }

    config.rateLimitAttempt = attempt
    const wait = retryAfter(error.response.headers['retry-after']) ?? attempt * delay
    log.warn(
      `Яндекс Музыка ответила 429, повтор ${attempt}/${retries} через ${wait} мс: ` +
        `${config.method?.toUpperCase()} ${config.url?.split('?')[0]}`
    )
    await sleep(wait)
    return http.request(config)
  })
}

/**
 * Пауза из заголовка Retry-After в миллисекундах. Поддерживается только число секунд
 */
function retryAfter(header: unknown): number | undefined {
  if (typeof header !== 'string' || header.trim() === '') {
    return undefined
  }

  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RATE_LIMIT_DELAY) : undefined
}

/**
 * Тело application/x-www-form-urlencoded: поле-массив передаётся повторяющимися ключами
 */
function toFormBody(fields: Record<string, string[] | undefined>): URLSearchParams {
  return new URLSearchParams(
    Object.entries(fields).flatMap(([key, values]) => (values ?? []).map(value => [key, value]))
  )
}
