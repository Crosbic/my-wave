import assert from 'node:assert/strict'
import { after, before, describe, it, TestContext } from 'node:test'
import path from 'path'
import { setTimeout as sleep } from 'timers/promises'

import {
  buttons,
  createTestSession,
  embedDescription,
  playerStatus,
  removeDir,
  tempDir,
  track,
  waitFor,
  writeSilentWav
} from './helpers.js'
import { YandexAuthError } from '../src/errors/yandexAuthError.js'
import { WaveSession } from '../src/services/wave-session.js'
import { StationFeedback, YandexMusicService } from '../src/services/yandex-music.service.js'
import { IStationBatch } from '../src/types/yandexTrack.js'

const yandex = YandexMusicService.getInstance()

let dir: string
let shortClip: string
let longClip: string

before(() => {
  dir = tempDir('wave-session')
  // Короткий клип успевает доиграть сам, длинный не заканчивается, пока тест нажимает кнопки
  shortClip = writeSilentWav(path.join(dir, 'short.wav'), 0.4)
  longClip = writeSilentWav(path.join(dir, 'long.wav'), 6)
})

after(() => removeDir(dir))

interface StubOptions {
  batches?: IStationBatch[]
  clip?: 'short' | 'long'
  brokenTracks?: string[]
  urlDelay?: number
  stationTracks?: () => Promise<IStationBatch>
  streamUrl?: (trackId: string) => string | null
}

function stubYandex(t: TestContext, options: StubOptions = {}) {
  const feedback: StationFeedback[] = []
  const queues: (string | undefined)[] = []
  const urlRequests: string[] = []
  const batches = [...(options.batches ?? [])]

  t.mock.method(yandex, 'getStationTracks', async (_token: string, _station: string, queue?: string) => {
    queues.push(queue)
    return options.stationTracks ? options.stationTracks() : (batches.shift() ?? { batchId: 'empty', tracks: [] })
  })
  t.mock.method(yandex, 'getStreamUrl', async (_token: string, trackId: string) => {
    urlRequests.push(trackId)
    if (options.urlDelay) {
      await sleep(options.urlDelay)
    }
    if (options.streamUrl) {
      return options.streamUrl(trackId)
    }
    if (options.brokenTracks?.includes(trackId)) {
      return path.join(dir, 'missing.wav')
    }
    return options.clip === 'long' ? longClip : shortClip
  })
  t.mock.method(yandex, 'sendStationFeedback', async (_token: string, _station: string, item: StationFeedback) => {
    feedback.push(item)
    return true
  })

  const started = (id: string) => feedback.filter(f => f.type === 'trackStarted' && f.trackId === `${id}:100`).length
  return { feedback, queues, urlRequests, started }
}

function startedSession(t: TestContext) {
  const test = createTestSession()
  t.after(() => test.session.destroy('Конец теста'))
  return test
}

async function waitForStart(session: WaveSession, started: (id: string) => number, id: string) {
  await waitFor(() => session.currentTrack?.id === id && started(id) === 1, `трек ${id} начал играть`)
}

function describeFeedback(feedback: StationFeedback[]): string[] {
  return feedback.map(item => ('trackId' in item ? `${item.type} ${item.trackId}` : item.type))
}

const batch = (batchId: string, ...ids: string[]): IStationBatch => ({ batchId, tracks: ids.map(id => track(id)) })

describe('WaveSession', () => {
  it('играет волну по порядку и отправляет станции фидбэк', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12')] })
    const { session } = startedSession(t)

    assert.equal(await session.start(), true)
    assert.equal(session.currentTrack?.id, '11')
    assert.deepEqual(yandexStub.queues, [undefined], 'первая партия запрашивается без queue')

    await waitForStart(session, yandexStub.started, '12')

    assert.deepEqual(describeFeedback(yandexStub.feedback), [
      'radioStarted',
      'trackStarted 11:100',
      'trackFinished 11:100',
      'trackStarted 12:100'
    ])
    const finished = yandexStub.feedback.find(item => item.type === 'trackFinished')
    assert.equal(finished && 'batchId' in finished ? finished.batchId : null, 'b1')
  })

  it('⏭️ сразу глушит трек, показывает загрузку и шлёт skip', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12')], clip: 'long' })
    const { session, edits } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')

    t.mock.method(yandex, 'getStreamUrl', async () => {
      await sleep(400)
      return longClip
    })
    const skipping = session.skip()
    await sleep(150)
    assert.equal(playerStatus(session), 'idle', 'текущий трек заглушён до загрузки следующего')
    assert.equal(embedDescription(edits.at(-1)), 'Загрузка трека...')
    await skipping

    assert.equal(session.currentTrack?.id, '12')
    assert.ok(
      yandexStub.feedback.some(item => item.type === 'skip' && item.trackId === '11:100' && item.batchId === 'b1')
    )
  })

  it('следующая партия запрашивается с queue последнего трека', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12'), batch('b2', '21', '22')], clip: 'long' })
    const { session } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await session.skip()
    await waitForStart(session, yandexStub.started, '12')
    await session.skip()

    assert.equal(session.currentTrack?.id, '21')
    assert.deepEqual(yandexStub.queues, [undefined, '12:100'])
  })

  it('⏮️ возвращает предыдущие треки, а ⏭️ ведёт обратно без дублей', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12'), batch('b2', '21', '22')], clip: 'long' })
    const { session } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await session.skip()
    await waitForStart(session, yandexStub.started, '12')
    await session.skip()

    assert.equal(await session.previous(), 'ok')
    assert.equal(session.currentTrack?.id, '12')
    assert.equal(await session.previous(), 'ok')
    assert.equal(session.currentTrack?.id, '11')
    assert.equal(await session.previous(), 'empty')

    await session.skip()
    assert.equal(session.currentTrack?.id, '12')
    await session.skip()
    assert.equal(session.currentTrack?.id, '21')

    assert.equal(yandexStub.started('11'), 1, 'повторное воспроизведение не шлёт trackStarted')
    assert.equal(yandexStub.started('12'), 1)
  })

  it('битый трек запускается не больше трёх раз, затем играет следующий', async t => {
    const yandexStub = stubYandex(t, {
      batches: [{ batchId: 'b1', tracks: [track('11', 200_000), track('12')] }],
      brokenTracks: ['11']
    })
    const { session } = startedSession(t)

    await session.start()
    await waitFor(() => session.currentTrack?.id === '12', 'переход к следующему треку')

    assert.equal(yandexStub.urlRequests.filter(id => id === '11').length, 3)
    assert.ok(!yandexStub.feedback.some(item => 'trackId' in item && item.trackId === '11:100'))
  })

  it('кнопки ⏮️, 👍 и ⏸️ выключены, пока ими нельзя воспользоваться', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12')], clip: 'long' })
    const { session, edits } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await waitFor(() => buttons(edits.at(-1)).like, 'плеер показал трек')
    assert.deepEqual(buttons(edits.at(-1)), { like: true, previous: false, pause: true, stop: true, next: true })

    t.mock.method(yandex, 'getStreamUrl', async () => {
      await sleep(400)
      return longClip
    })
    const skipping = session.skip()
    await sleep(150)
    assert.deepEqual(buttons(edits.at(-1)), { like: false, previous: true, pause: false, stop: true, next: true })
    await skipping
    await waitFor(() => buttons(edits.at(-1)).like, 'плеер показал следующий трек')
    assert.equal(buttons(edits.at(-1)).previous, true)
  })

  it('пауза и продолжение меняют кнопку', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11')], clip: 'long' })
    const { session, edits } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')

    assert.equal(session.pause(), true)
    await waitFor(() => 'resume' in buttons(edits.at(-1)), 'кнопка ▶️')
    assert.equal(session.resume(), true)
    await waitFor(() => 'pause' in buttons(edits.at(-1)), 'кнопка ⏸️')
  })

  it('недействительный токен останавливает плеер с понятной причиной', async t => {
    stubYandex(t, {
      stationTracks: async () => {
        throw new YandexAuthError()
      }
    })
    const { session, connection, isDestroyed } = startedSession(t)

    assert.equal(await session.start(), false)
    assert.match(session.stopReason ?? '', /Токен Яндекса/)
    assert.ok(isDestroyed())
    assert.equal(connection.state.status, 'destroyed')
  })

  it('после пяти недоступных треков подряд плеер останавливается', async t => {
    let id = 0
    const yandexStub = stubYandex(t, {
      stationTracks: async () => batch('b', String(++id), String(++id)),
      streamUrl: () => null
    })
    const { session } = startedSession(t)

    assert.equal(await session.start(), false)
    assert.equal(yandexStub.urlRequests.length, 5)
    assert.match(session.stopReason ?? '', /несколько треков подряд/)
  })

  it('если API станции недоступен, после трёх попыток плеер останавливается', async t => {
    const yandexStub = stubYandex(t, {
      stationTracks: async () => {
        throw new Error('ECONNRESET')
      }
    })
    const { session } = startedSession(t)

    assert.equal(await session.start(), false)
    assert.equal(yandexStub.queues.length, 3)
    assert.match(session.stopReason ?? '', /Не удалось загрузить треки/)
  })

  it('destroy освобождает ресурсы и больше не трогает сообщение', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11')], clip: 'long' })
    const { session, connection, edits, isDestroyed } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await session.destroy('Плеер был остановлен.')

    assert.ok(isDestroyed())
    assert.equal(connection.state.status, 'destroyed')
    assert.equal(playerStatus(session), 'idle')
    assert.deepEqual(edits.at(-1)?.components, [])

    const editsAfterStop = edits.length
    await sleep(300)
    assert.equal(edits.length, editsAfterStop)
  })
})
