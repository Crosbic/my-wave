import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'

import axios, { AxiosError, AxiosHeaders, AxiosInstance, InternalAxiosRequestConfig, isAxiosError } from 'axios'

import { YandexAuthError } from '../src/errors/yandexAuthError.js'
import { retryOnRateLimit, YandexMusicService } from '../src/services/yandex-music.service.js'

interface Request {
  method: 'get' | 'post'
  url: string
  body?: unknown
  config?: { params?: Record<string, unknown>; headers?: Record<string, string> }
}

/**
 * Клиент с подменённым http: запросы записываются, ответы задаются тестом
 */
function createClient(respond: (request: Request) => unknown) {
  const requests: Request[] = []
  const client = Object.create(YandexMusicService.prototype) as YandexMusicService
  Object.assign(client, {
    http: {
      get: async (url: string, config: Request['config']) => {
        const request: Request = { method: 'get', url, config }
        requests.push(request)
        return { data: respond(request) }
      },
      post: async (url: string, body: unknown, config: Request['config']) => {
        const request: Request = { method: 'post', url, body, config }
        requests.push(request)
        return { data: respond(request) }
      }
    }
  })
  return { client, requests }
}

function unauthorized(): AxiosError {
  const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig
  return new AxiosError(
    'Unauthorized',
    'ERR_BAD_REQUEST',
    config,
    {},
    {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config,
      data: {}
    }
  )
}

const sequence = [
  { track: { id: '1', title: 'A', available: true, artists: [{ name: 'X' }], albums: [{ id: 7, title: 'Al' }] } },
  { track: { id: '2', title: 'B', available: false, artists: [], albums: [] } }
]

interface FeedbackBody {
  event: Record<string, unknown>
  batchId?: string
  from: string
}

describe('YandexMusicService', () => {
  it('создаёт сессию волны с сидами и queue и отбрасывает недоступные треки', async () => {
    const { client, requests } = createClient(() => ({
      result: { radioSessionId: 'session-1', batchId: 'batch-1', sequence }
    }))

    const session = await client.createWaveSession('token', ['user:onyourwave', 'settingMoodEnergy:active'], ['5:6'])

    assert.equal(requests[0].url, '/rotor/session/new')
    assert.deepEqual(requests[0].body, {
      seeds: ['user:onyourwave', 'settingMoodEnergy:active'],
      queue: ['5:6'],
      includeTracksInResponse: true,
      includeWaveModel: true,
      interactive: true
    })
    assert.equal(requests[0].config?.headers?.Authorization, 'OAuth token')
    assert.equal(session.sessionId, 'session-1')
    assert.equal(session.batchId, 'batch-1')
    assert.deepEqual(
      session.tracks.map(track => YandexMusicService.fullTrackId(track)),
      ['1:7']
    )

    await client.createWaveSession('token', ['user:onyourwave'])
    assert.ok(!('queue' in (requests[1].body as object)), 'новая волна без истории запускается без queue')
  })

  it('следующая партия запрашивается у сессии, а завершённая сессия даёт null', async () => {
    let response: object = { result: { batchId: 'batch-2', sequence } }
    const { client, requests } = createClient(() => response)

    const batch = await client.getWaveTracks('token', 'session-1', ['1:7', '3:7'])

    assert.equal(requests[0].url, '/rotor/session/session-1/tracks')
    assert.deepEqual(requests[0].body, { queue: ['1:7', '3:7'] })
    assert.equal(batch?.batchId, 'batch-2')
    assert.deepEqual(
      batch?.tracks.map(track => track.id),
      ['1']
    )

    response = { result: { unknownSession: true } }
    assert.equal(await client.getWaveTracks('token', 'session-1', []), null)
    response = { result: { terminated: true, batchId: 'batch-3', sequence } }
    assert.equal(await client.getWaveTracks('token', 'session-1', []), null)
  })

  it('фидбэк сессии: трек и секунды в событии, batchId и from рядом, у radioStarted нет трека', async () => {
    const { client, requests } = createClient(() => ({ result: {} }))

    await client.sendWaveFeedback('token', 'session-1', {
      type: 'skip',
      trackId: '1:7',
      batchId: 'batch-1',
      totalPlayedSeconds: 1.585
    })
    await client.sendWaveFeedback('token', 'session-1', { type: 'radioStarted' })

    const [skip, radioStarted] = requests
    assert.equal(skip.url, '/rotor/session/session-1/feedback')
    const skipBody = skip.body as FeedbackBody
    const { timestamp, ...skipEvent } = skipBody.event
    assert.deepEqual(skipEvent, { type: 'skip', trackId: '1:7', totalPlayedSeconds: 1.585 })
    assert.match(String(timestamp), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.equal(skipBody.batchId, 'batch-1')
    assert.equal(skipBody.from, 'ym-player-bot')

    const startBody = radioStarted.body as FeedbackBody
    assert.ok(!('batchId' in startBody), 'radioStarted отправляется без batchId')
    assert.ok(!('trackId' in startBody.event))
    assert.equal(startBody.event.from, 'ym-player-bot')
  })

  it('настройки волны: занятия и значения без «Любое», название «Любое» из ответа', async () => {
    const { client, requests } = createClient(() => ({
      result: {
        defaultStation: { stationId: 'user:1', title: 'Моя волна' },
        blocks: [
          {
            type: 'contexts',
            items: [
              { id: { type: 'activity', tag: 'wake-up' }, name: 'Просыпаюсь' },
              { id: { type: 'activity', tag: 'workout' }, name: 'Тренируюсь' }
            ]
          }
        ],
        settingRestrictions: {
          diversity: {
            type: 'enum',
            name: 'По характеру',
            possibleValues: [
              { value: 'favorite', name: 'Любимое', serializedSeed: 'settingDiversity:favorite' },
              { value: 'default', name: 'Любое', serializedSeed: 'settingDiversity:default', unspecified: true }
            ]
          },
          language: {
            type: 'enum',
            name: 'По языку',
            possibleValues: [
              { value: 'russian', name: 'Русский', serializedSeed: 'settingLanguage:russian' },
              { value: 'any', name: 'Любой', serializedSeed: 'settingLanguage:any', unspecified: true },
              { value: 'without-words', name: 'Без слов', serializedSeed: 'settingLanguage:without-words' }
            ]
          }
        }
      }
    }))

    const groups = await client.getWaveSettings('token')

    assert.equal(requests[0].url, '/rotor/wave/settings')
    assert.deepEqual(groups, [
      {
        key: 'activity',
        name: 'Под занятие',
        anyName: 'Любое',
        options: [
          { seed: 'activity:wake-up', name: 'Просыпаюсь' },
          { seed: 'activity:workout', name: 'Тренируюсь' }
        ]
      },
      {
        key: 'diversity',
        name: 'По характеру',
        anyName: 'Любое',
        options: [{ seed: 'settingDiversity:favorite', name: 'Любимое' }]
      },
      {
        key: 'language',
        name: 'По языку',
        anyName: 'Любой',
        options: [
          { seed: 'settingLanguage:russian', name: 'Русский' },
          { seed: 'settingLanguage:without-words', name: 'Без слов' }
        ]
      }
    ])
  })

  it('выбирает полный mp3 с максимальным битрейтом и подписывает ссылку', async () => {
    const { client, requests } = createClient(request => {
      if (request.url.endsWith('/download-info')) {
        return {
          result: [
            { codec: 'aac', bitrateInKbps: 256, preview: false, downloadInfoUrl: 'https://storage/aac' },
            { codec: 'mp3', bitrateInKbps: 320, preview: true, downloadInfoUrl: 'https://storage/preview' },
            { codec: 'mp3', bitrateInKbps: 192, preview: false, downloadInfoUrl: 'https://storage/mp3-192' },
            { codec: 'mp3', bitrateInKbps: 320, preview: false, downloadInfoUrl: 'https://storage/mp3-320' }
          ]
        }
      }
      return { host: 'host.example', path: '/path/to/file', ts: '0001', s: 'salt' }
    })

    const url = await client.getStreamUrl('token', '42')

    assert.equal(requests[1].url, 'https://storage/mp3-320')
    assert.deepEqual(requests[1].config?.params, { format: 'json' })
    const sign = crypto
      .createHash('md5')
      .update('XGRlBW9FXlekgbPrRHuSiA' + 'path/to/file' + 'salt')
      .digest('hex')
    assert.equal(url, `https://host.example/get-mp3/${sign}/0001/path/to/file`)
  })

  it('лайк отправляет поле track-ids', async () => {
    const { client, requests } = createClient(() => ({ result: { revision: 1 } }))

    assert.equal(await client.likeTrack('token', 'uid', '1:7'), true)
    assert.equal(requests[0].url, '/users/uid/likes/tracks/add-multiple')
    assert.ok(requests[0].body instanceof URLSearchParams)
    assert.deepEqual([...(requests[0].body as URLSearchParams)], [['track-ids', '1:7']])
  })

  it('ответ 401 превращается в YandexAuthError, а сбой фидбэка — нет', async () => {
    const { client } = createClient(() => {
      throw unauthorized()
    })

    await assert.rejects(client.createWaveSession('token', ['user:onyourwave']), YandexAuthError)
    await assert.rejects(client.getWaveTracks('token', 'session-1', []), YandexAuthError)
    await assert.rejects(client.getWaveSettings('token'), YandexAuthError)
    await assert.rejects(client.getStreamUrl('token', '1'), YandexAuthError)
    await assert.rejects(client.likeTrack('token', 'uid', '1'), YandexAuthError)
    assert.equal(await client.sendWaveFeedback('token', 'session-1', { type: 'radioStarted' }), false)
  })
})

interface RateLimitedServer {
  // Статусы ответов по порядку; когда они кончаются, отвечает 200
  statuses: number[]
  headers?: Record<string, string>
  delay?: number
}

/**
 * Настоящий клиент axios с повтором при 429, но вместо сети — адаптер с заданными ответами
 */
function rateLimitedClient({ statuses, headers = {}, delay = 1 }: RateLimitedServer) {
  const requests: string[] = []
  const http = axios.create({ adapter: fakeAdapter(statuses, headers, requests) })
  retryOnRateLimit(http, { delay })
  return { http, requests }
}

function fakeAdapter(statuses: number[], headers: Record<string, string>, requests: string[]) {
  return async (config: InternalAxiosRequestConfig) => {
    requests.push(`${config.method} ${config.url} ${config.data ?? ''}`)
    const status = statuses.shift() ?? 200
    const response = { status, statusText: '', headers, config, data: { result: status } }
    if (status >= 400) {
      throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, {}, response)
    }
    return response
  }
}

describe('повтор запросов при 429', () => {
  it('клиент Яндекс Музыки повторяет запросы при 429', async t => {
    const { http } = YandexMusicService.getInstance() as unknown as { http: AxiosInstance }
    const adapter = http.defaults.adapter
    t.after(() => {
      http.defaults.adapter = adapter
    })
    const requests: string[] = []
    http.defaults.adapter = fakeAdapter([429], { 'retry-after': '0' }, requests)

    await YandexMusicService.getInstance().getWaveSettings('token')

    assert.deepEqual(requests, ['get /rotor/wave/settings ', 'get /rotor/wave/settings '])
  })

  it('повторяет запрос с тем же телом, пока Яндекс Музыка отвечает 429', async () => {
    const { http, requests } = rateLimitedClient({ statuses: [429, 429] })

    const response = await http.post('/rotor/session/new', { seeds: ['user:onyourwave'] })

    assert.equal(response.status, 200)
    assert.equal(requests.length, 3)
    assert.ok(
      requests.every(request => request === requests[0]),
      'тело и адрес не меняются между попытками'
    )
  })

  it('после двух повторов отдаёт ошибку 429, а другие ошибки не повторяет', async () => {
    const limited = rateLimitedClient({ statuses: [429, 429, 429] })
    await assert.rejects(
      limited.http.get('/rotor/wave/settings'),
      (error: unknown) => isAxiosError(error) && error.response?.status === 429
    )
    assert.equal(limited.requests.length, 3)

    const failed = rateLimitedClient({ statuses: [500] })
    await assert.rejects(failed.http.get('/rotor/wave/settings'))
    assert.equal(failed.requests.length, 1)
  })

  it('пауза перед повтором берётся из Retry-After', async () => {
    const { http, requests } = rateLimitedClient({ statuses: [429], headers: { 'retry-after': '0' }, delay: 5_000 })

    const start = Date.now()
    await http.get('/rotor/wave/settings')

    assert.equal(requests.length, 2)
    assert.ok(Date.now() - start < 2_000, 'без Retry-After пауза была бы 5 секунд')
  })
})
