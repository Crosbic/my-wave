import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'

import { AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from 'axios'

import { YandexAuthError } from '../src/errors/yandexAuthError.js'
import { YandexMusicService } from '../src/services/yandex-music.service.js'

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

describe('YandexMusicService', () => {
  it('запрашивает треки станции с settings2 и queue и отбрасывает недоступные', async () => {
    const { client, requests } = createClient(() => ({
      result: {
        batchId: 'batch-1',
        sequence: [
          {
            track: { id: '1', title: 'A', available: true, artists: [{ name: 'X' }], albums: [{ id: 7, title: 'Al' }] }
          },
          { track: { id: '2', title: 'B', available: false, artists: [], albums: [] } }
        ]
      }
    }))

    const batch = await client.getStationTracks('token', 'user:onyourwave', '5:6')

    assert.equal(requests[0].url, '/rotor/station/user:onyourwave/tracks')
    assert.deepEqual(requests[0].config?.params, { settings2: true, queue: '5:6' })
    assert.equal(requests[0].config?.headers?.Authorization, 'OAuth token')
    assert.equal(batch.batchId, 'batch-1')
    assert.deepEqual(
      batch.tracks.map(track => YandexMusicService.fullTrackId(track)),
      ['1:7']
    )
  })

  it('передаёт batch-id в query, а trackId и секунды — в теле фидбэка', async () => {
    const { client, requests } = createClient(() => ({ result: 'ok' }))

    await client.sendStationFeedback('token', 'user:onyourwave', {
      type: 'skip',
      trackId: '1:7',
      batchId: 'batch-1',
      totalPlayedSeconds: 12
    })
    await client.sendStationFeedback('token', 'user:onyourwave', { type: 'radioStarted' })

    const [skip, radioStarted] = requests
    assert.deepEqual(skip.config?.params, { 'batch-id': 'batch-1' })
    assert.deepEqual(
      { type: (skip.body as Record<string, unknown>).type, trackId: (skip.body as Record<string, unknown>).trackId },
      { type: 'skip', trackId: '1:7' }
    )
    assert.equal((skip.body as Record<string, unknown>).totalPlayedSeconds, 12)
    assert.equal(radioStarted.config?.params, undefined, 'radioStarted отправляется без batch-id')
    assert.ok(!('trackId' in (radioStarted.body as object)))
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

    await assert.rejects(client.getStationTracks('token', 'user:onyourwave'), YandexAuthError)
    await assert.rejects(client.getStreamUrl('token', '1'), YandexAuthError)
    await assert.rejects(client.likeTrack('token', 'uid', '1'), YandexAuthError)
    assert.equal(await client.sendStationFeedback('token', 'user:onyourwave', { type: 'radioStarted' }), false)
  })
})
