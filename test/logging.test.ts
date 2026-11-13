import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DiscordAPIError, RepliableInteraction, RESTJSONErrorCodes } from 'discord.js'

import { AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from 'axios'

import { captureLogs } from './helpers.js'
import config from '../src/config.js'
import { describeError } from '../src/utils/errors.js'
import { dismiss, respond } from '../src/utils/interactions.js'
import { createLogger } from '../src/utils/logger.js'

const TOKEN = 'SECRET-OAUTH-TOKEN'

function axiosErrorWithToken(): AxiosError {
  const config = {
    method: 'get',
    baseURL: 'https://api.music.yandex.net',
    url: '/rotor/station/user:onyourwave/tracks?queue=1',
    headers: new AxiosHeaders({ Authorization: `OAuth ${TOKEN}` })
  } as InternalAxiosRequestConfig

  return new AxiosError(
    'Request failed with status code 500',
    'ERR_BAD_RESPONSE',
    config,
    { _header: `Authorization: OAuth ${TOKEN}` },
    { status: 500, statusText: '', headers: {}, config, data: { error: 'internal' } }
  )
}

describe('логи без токенов', () => {
  it('describeError оставляет метод, адрес без query, статус и тело ответа', () => {
    const text = describeError(axiosErrorWithToken())

    assert.equal(
      text,
      'GET https://api.music.yandex.net/rotor/station/user:onyourwave/tracks -> HTTP 500: {"error":"internal"}'
    )
  })

  it('логгер не выводит токен из ошибки axios', t => {
    const output = t.mock.method(console, 'error', () => {})
    const level = config.logLevel
    config.logLevel = 'error'
    t.after(() => {
      config.logLevel = level
    })

    createLogger('test').error('Запрос упал', axiosErrorWithToken())

    const line = String(output.mock.calls[0].arguments[0])
    assert.match(line, /ERROR \[test\] Запрос упал GET https:\/\/api\.music\.yandex\.net/)
    assert.ok(!line.includes(TOKEN))
  })

  it('уровень в строке лога выделяется цветом, если цвета включены', t => {
    const output = t.mock.method(console, 'warn', () => {})
    const { logLevel, logColors } = config
    config.logLevel = 'info'
    config.logColors = true
    t.after(() => {
      config.logLevel = logLevel
      config.logColors = logColors
    })

    createLogger('test').warn('Повтор запроса')

    const line = String(output.mock.calls[0].arguments[0])
    assert.ok(line.endsWith(' \u001b[33mWARN\u001b[39m  [test] Повтор запроса'), 'цветом выделен только уровень')
  })
})

describe('уровни логов при ответах на взаимодействия', () => {
  function discordError(code: number): DiscordAPIError {
    return new DiscordAPIError({ code, message: 'Unknown' }, code, 404, 'POST', '/interactions', {})
  }

  it('если сообщения или взаимодействия уже нет, это не ошибка бота', async t => {
    const logs = captureLogs(t)

    const closed = {
      deleteReply: async () => {
        throw discordError(RESTJSONErrorCodes.UnknownMessage)
      }
    }
    await dismiss(closed as unknown as RepliableInteraction)
    assert.deepEqual(logs, [], 'пользователь сам закрыл сообщение: это только debug')

    const expired = {
      replied: false,
      deferred: false,
      reply: async () => {
        throw discordError(RESTJSONErrorCodes.UnknownInteraction)
      }
    }
    await respond(expired as unknown as RepliableInteraction, 'Готово')
    assert.deepEqual(
      logs.map(({ level }) => level),
      ['warn'],
      'взаимодействие истекло, и пользователь остался без ответа'
    )

    const broken = {
      replied: false,
      deferred: false,
      reply: async () => {
        throw new Error('ECONNRESET')
      }
    }
    await respond(broken as unknown as RepliableInteraction, 'Готово')
    assert.deepEqual(
      logs.map(({ level }) => level),
      ['warn', 'error']
    )
  })
})
