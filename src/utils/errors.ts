import { DiscordAPIError } from 'discord.js'

import { isAxiosError } from 'axios'

const MAX_BODY_LENGTH = 300

/**
 * Ошибка, текст которой можно показать пользователю как есть
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserFacingError'
  }
}

/**
 * Ошибка API Discord с одним из кодов, например RESTJSONErrorCodes.UnknownMessage
 */
export function isDiscordError(error: unknown, ...codes: number[]): boolean {
  return error instanceof DiscordAPIError && typeof error.code === 'number' && codes.includes(error.code)
}

/**
 * Краткое описание ошибки для логов.
 * Для ошибок axios не выводит заголовки и параметры запроса, чтобы токены не попадали в логи.
 */
export function describeError(error: unknown): string {
  if (isAxiosError(error)) {
    const method = error.config?.method?.toUpperCase() ?? 'HTTP'
    const url = error.config?.url ?? ''
    const fullUrl = /^https?:\/\//.test(url) ? url : `${error.config?.baseURL ?? ''}${url}`
    const status = error.response ? `HTTP ${error.response.status}` : (error.code ?? error.message)
    const body = formatBody(error.response?.data)

    return `${method} ${fullUrl.split('?')[0]} -> ${status}${body ? `: ${body}` : ''}`
  }

  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }

  return String(error)
}

function formatBody(data: unknown): string {
  if (data === undefined || data === null || data === '') {
    return ''
  }

  const text = typeof data === 'string' ? data : JSON.stringify(data)
  return text.length > MAX_BODY_LENGTH ? `${text.slice(0, MAX_BODY_LENGTH)}...` : text
}
