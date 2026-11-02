import crypto from 'crypto'

import axios, { isAxiosError } from 'axios'

import { IUserData } from '../types/userData.js'
import { IStationBatch, IYandexTrack } from '../types/yandexTrack.js'
import { describeError } from '../utils/errors.js'

const API_URL = 'https://api.music.yandex.net'
const REQUEST_TIMEOUT = 15_000

// Соль для подписи прямой ссылки на файл, как в эталонном клиенте MarshalX/yandex-music-api
const SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA'
const FEEDBACK_FROM = 'ym-player-bot'

/**
 * Яндекс отклонил токен: он истёк или был отозван
 */
export class YandexAuthError extends Error {
  constructor() {
    super('Токен Яндекса недействителен или истёк')
    this.name = 'YandexAuthError'
  }
}

/**
 * Фидбэк станции. batchId передаётся как batch-id и должен отсутствовать для radioStarted
 */
export type StationFeedback =
  | { type: 'radioStarted' }
  | { type: 'trackStarted'; trackId: string; batchId: string | null }
  | { type: 'trackFinished' | 'skip'; trackId: string; batchId: string | null; totalPlayedSeconds: number }

interface IApiTrack {
  id: string | number
  title: string
  available?: boolean
  artists?: Array<{ name: string }>
  albums?: Array<{ id?: number; title?: string }>
  coverUri?: string
  durationMs?: number
}

interface IDownloadInfo {
  codec: string
  bitrateInKbps: number
  preview?: boolean | string
  downloadInfoUrl: string
}

interface IDirectLinkInfo {
  host?: string
  path?: string
  ts?: string
  s?: string
}

export class YandexMusicService {
  private static instance: YandexMusicService
  private readonly http = axios.create({ baseURL: API_URL, timeout: REQUEST_TIMEOUT })

  private constructor() {}

  public static getInstance(): YandexMusicService {
    if (!YandexMusicService.instance) {
      YandexMusicService.instance = new YandexMusicService()
    }
    return YandexMusicService.instance
  }

  /**
   * Идентификатор трека в формате «трек:альбом», который ждут фидбэк станции, параметр queue и лайки
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
        this.http.get('/account/status', { headers: this.authHeaders(token) }),
        axios.get('https://login.yandex.ru/info', {
          params: { format: 'json' },
          headers: this.authHeaders(token),
          timeout: REQUEST_TIMEOUT
        })
      ])

      const user = userResponse.data
      const hasPlus = !!statusResponse.data?.result?.plus?.hasPlus

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
   * Получение следующей партии треков станции.
   * queue — идентификатор трека, который только что играл: по нему станция продолжает волну, а не начинает заново
   */
  public async getStationTracks(token: string, stationId: string, queue?: string): Promise<IStationBatch> {
    try {
      const response = await this.http.get(`/rotor/station/${stationId}/tracks`, {
        headers: this.authHeaders(token),
        params: { settings2: true, queue }
      })

      const result = response.data?.result
      const sequence: Array<{ track?: IApiTrack }> = result?.sequence ?? []
      const tracks = sequence
        .map(item => item.track)
        .filter((track): track is IApiTrack => !!track && track.available !== false)
        .map(track => this.toTrack(track))

      return { batchId: result?.batchId ?? null, tracks }
    } catch (error) {
      throw this.wrapError(error)
    }
  }

  /**
   * Отправка фидбэка станции. Ошибки только логируются: фидбэк не должен мешать воспроизведению
   */
  public async sendStationFeedback(token: string, stationId: string, feedback: StationFeedback): Promise<boolean> {
    const body: Record<string, string | number> = {
      type: feedback.type,
      timestamp: new Date().toISOString().replace('Z', ''),
      from: FEEDBACK_FROM
    }
    let params: Record<string, string> | undefined

    if (feedback.type !== 'radioStarted') {
      body.trackId = feedback.trackId
      if (feedback.batchId) {
        params = { 'batch-id': feedback.batchId }
      }
      if (feedback.type !== 'trackStarted') {
        body.totalPlayedSeconds = feedback.totalPlayedSeconds
      }
    }

    try {
      await this.http.post(`/rotor/station/${stationId}/feedback`, body, { headers: this.authHeaders(token), params })
      return true
    } catch (error) {
      console.warn(`Не удалось отправить фидбэк ${feedback.type} станции ${stationId}:`, describeError(error))
      return false
    }
  }

  /**
   * Получение прямой ссылки на аудиофайл трека. Ссылка на download-info живёт около минуты,
   * поэтому получать её нужно непосредственно перед воспроизведением
   */
  public async getStreamUrl(token: string, trackId: string): Promise<string | null> {
    try {
      const infoResponse = await this.http.get(`/tracks/${trackId}/download-info`, { headers: this.authHeaders(token) })
      const variant = this.pickDownloadVariant(infoResponse.data?.result ?? [])
      if (!variant) {
        console.warn(`Для трека ${trackId} нет доступных вариантов загрузки`)
        return null
      }

      const linkResponse = await this.http.get<IDirectLinkInfo>(variant.downloadInfoUrl, {
        headers: this.authHeaders(token),
        params: { format: 'json' }
      })
      const { host, path, ts, s } = linkResponse.data ?? {}
      if (!host || !path || !ts || !s) {
        console.warn(`Не удалось получить данные для загрузки трека ${trackId}`)
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
      console.error(`Не удалось получить ссылку на трек ${trackId}:`, describeError(error))
      return null
    }
  }

  /**
   * Добавление трека в «Мне нравится»
   */
  public async likeTrack(token: string, userId: string, trackId: string): Promise<boolean> {
    try {
      await this.http.post(
        `/users/${userId}/likes/tracks/add-multiple`,
        new URLSearchParams({ 'track-ids': trackId }),
        { headers: this.authHeaders(token) }
      )
      return true
    } catch (error) {
      const wrapped = this.wrapError(error)
      if (wrapped instanceof YandexAuthError) {
        throw wrapped
      }
      console.error(`Не удалось добавить трек ${trackId} в «Мне нравится»:`, describeError(error))
      return false
    }
  }

  /**
   * Лучший вариант загрузки: полная версия, mp3, максимальный битрейт
   */
  private pickDownloadVariant(variants: IDownloadInfo[]): IDownloadInfo | undefined {
    const isPreview = (variant: IDownloadInfo) => variant.preview === true || variant.preview === 'true'

    return [...variants].sort(
      (a, b) =>
        Number(isPreview(a)) - Number(isPreview(b)) ||
        Number(a.codec !== 'mp3') - Number(b.codec !== 'mp3') ||
        b.bitrateInKbps - a.bitrateInKbps
    )[0]
  }

  private toTrack(track: IApiTrack): IYandexTrack {
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
