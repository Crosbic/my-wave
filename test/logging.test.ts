import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from 'axios'

import config from '../src/config.js'
import { describeError } from '../src/utils/errors.js'
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
})
