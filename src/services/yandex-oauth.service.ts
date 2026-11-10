import crypto from 'crypto'

import axios, { isAxiosError } from 'axios'

import config from '../config.js'
import { YandexTokens } from '../types/userData.js'

const OAUTH_URL = 'https://oauth.yandex.ru'
const REQUEST_TIMEOUT = 15_000
// Своё OAuth-приложение с доступом к Музыке создать нельзя, поэтому бот входит от имени Android-приложения
// Яндекс Музыки. Его client_id и client_secret публичные, ими пользуются и другие клиенты (MarshalX/yandex-music-api)
const CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d'
const CLIENT_SECRET = '53bc75238f0c4d08a118e51fe9203300'
// Под этим именем бот виден на странице управления доступом в Яндекс ID, оттуда пользователь может его отключить
export const DEVICE_NAME = 'Discord-бот My Wave'
// Если Яндекс не прислал интервал опроса, ждём столько секунд, сколько велит RFC 8628
const DEFAULT_POLL_INTERVAL = 5

interface ApiDeviceCode {
  device_code: string
  user_code: string
  verification_url: string
  interval?: number
  expires_in: number
}

interface ApiToken {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

interface ApiError {
  error?: string
}

/**
 * Код для входа: пользователь вводит userCode на странице verificationUrl.
 * interval и expiresIn — в секундах
 */
export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUrl: string
  interval: number
  expiresIn: number
}

/**
 * Итог одного опроса: пользователь ещё не подтвердил вход, код истёк, пользователь отказал или токены выданы
 */
export type DeviceTokenResult =
  { status: 'pending' } | { status: 'expired' } | { status: 'denied' } | { status: 'granted'; tokens: YandexTokens }

/**
 * Вход в Яндекс по коду (OAuth Device Flow): бот показывает код, пользователь вводит его на ya.ru/device
 * там, где уже вошёл в Яндекс, а бот тем временем опрашивает Яндекс, пока тот не выдаст токен.
 * Полученные так токены бот может продлить и отозвать
 */
export class YandexOAuthService {
  private static instance: YandexOAuthService
  private readonly http = axios.create({ baseURL: OAUTH_URL, timeout: REQUEST_TIMEOUT })

  private constructor() {}

  public static getInstance(): YandexOAuthService {
    if (!YandexOAuthService.instance) {
      YandexOAuthService.instance = new YandexOAuthService()
    }
    return YandexOAuthService.instance
  }

  /**
   * Новый код для входа пользователя Discord
   */
  public async requestDeviceCode(discordId: string): Promise<DeviceCode> {
    const { data } = await this.http.post<ApiDeviceCode>(
      '/device/code',
      new URLSearchParams({ client_id: CLIENT_ID, device_id: deviceIdFor(discordId), device_name: DEVICE_NAME })
    )
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUrl: data.verification_url,
      interval: data.interval ?? DEFAULT_POLL_INTERVAL,
      expiresIn: data.expires_in
    }
  }

  /**
   * Один опрос: подтвердил ли пользователь вход по коду
   */
  public async pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    try {
      const { data } = await this.http.post<ApiToken>(
        '/token',
        new URLSearchParams({
          grant_type: 'device_code',
          code: deviceCode,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET
        })
      )
      return { status: 'granted', tokens: toTokens(data) }
    } catch (error) {
      switch (oauthError(error)) {
        case 'authorization_pending':
          return { status: 'pending' }
        // На истёкший и на неизвестный код Яндекс отвечает invalid_grant, expired_token — вариант из RFC 8628
        case 'invalid_grant':
        case 'expired_token':
          return { status: 'expired' }
        case 'access_denied':
          return { status: 'denied' }
        default:
          throw error
      }
    }
  }

  /**
   * Продление токена, полученного входом по коду. null — Яндекс отказался продлевать:
   * пользователь отключил бота в Яндекс ID или срок токена уже вышел
   */
  public async refreshTokens(refreshToken: string): Promise<YandexTokens | null> {
    try {
      const { data } = await this.http.post<ApiToken>(
        '/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET
        })
      )
      return toTokens(data, refreshToken)
    } catch (error) {
      if (oauthError(error) === 'invalid_grant') {
        return null
      }
      throw error
    }
  }

  /**
   * Отзыв токена, полученного входом по коду. Токены, выданные без устройства, Яндекс отозвать не даёт.
   * Уже недействительный токен Яндекс тоже считает отозванным
   */
  public async revokeToken(accessToken: string): Promise<void> {
    await this.http.post(
      '/revoke_token',
      new URLSearchParams({ access_token: accessToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    )
  }
}

/**
 * Идентификатор устройства для Яндекса. Он постоянный, чтобы повторный вход не добавлял в Яндекс ID новое устройство,
 * и свой у каждого пользователя Discord, чтобы два пользователя с одним аккаунтом Яндекса не выбивали друг друга.
 * Сам Discord ID Яндекс не видит
 */
export function deviceIdFor(discordId: string): string {
  return crypto
    .createHmac('sha256', config.encryptionKey)
    .update(`yandex-device:${discordId}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Токены из ответа Яндекса. При продлении Яндекс может оставить прежний refresh-токен и тогда его не присылает
 */
function toTokens(data: ApiToken, previousRefreshToken?: string): YandexTokens {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previousRefreshToken,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined
  }
}

/**
 * Код ошибки OAuth из ответа Яндекса, например authorization_pending
 */
function oauthError(error: unknown): string | undefined {
  return isAxiosError<ApiError>(error) ? error.response?.data?.error : undefined
}
