import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, before, describe, it, TestContext } from 'node:test'
import path from 'path'
import { setTimeout as sleep } from 'timers/promises'

import {
  buttons,
  createTestSession,
  embedDescription,
  FAST_TIMINGS,
  playerStatus,
  removeDir,
  runningProcesses,
  tempDir,
  track,
  waitFor,
  writeSilentWav
} from './helpers.js'
import { YandexAuthError } from '../src/errors/yandexAuthError.js'
import { WaveSession } from '../src/services/wave-session.js'
import { WaveFeedback, YandexMusicService } from '../src/services/yandex-music.service.js'
import { WaveChoice } from '../src/types/waveSettings.js'
import { IStationBatch } from '../src/types/yandexTrack.js'

const yandex = YandexMusicService.getInstance()

let dir: string
let shortClip: string
let longClip: string
let compactClip: string

before(() => {
  dir = tempDir('wave-session')
  // Короткий клип успевает доиграть сам, длинный не заканчивается, пока тест нажимает кнопки
  shortClip = writeSilentWav(path.join(dir, 'short.wav'), 0.4)
  longClip = writeSilentWav(path.join(dir, 'long.wav'), 6)
  // Компактный клип, как MP3: ffmpeg сразу получает файл целиком, а звук из него ещё долго не дочитан
  compactClip = writeSilentWav(path.join(dir, 'compact.wav'), 10, { sampleRate: 8_000, channels: 1, bits: 8 })
})

after(() => removeDir(dir))

interface StubOptions {
  // Партии по порядку: и при создании сессии волны, и при запросе следующей. null — Яндекс Музыка завершила сессию
  batches?: (IStationBatch | null)[]
  clip?: 'short' | 'long' | 'compact'
  brokenTracks?: string[]
  streamDelay?: number
  nextBatch?: () => Promise<IStationBatch | null>
  // Файл, который «скачивается» для трека. null — загрузить файл не удалось
  streamFile?: (trackId: string) => string | null
}

function stubYandex(t: TestContext, options: StubOptions = {}) {
  const feedback: { sessionId: string; item: WaveFeedback }[] = []
  // Созданные сессии волны: сиды и queue каждой. Сессия с номером n получает идентификатор sn
  const sessions: { seeds: string[]; queue: string[] }[] = []
  const queues: string[][] = []
  const streamRequests: string[] = []
  const batches = [...(options.batches ?? [])]
  const empty: IStationBatch = { batchId: 'empty', tracks: [] }
  const nextBatch = options.nextBatch ?? (async () => (batches.length > 0 ? batches.shift()! : empty))

  t.mock.method(yandex, 'createWaveSession', async (_token: string, seeds: string[], queue: string[] = []) => {
    sessions.push({ seeds, queue })
    return { sessionId: `s${sessions.length}`, ...((await nextBatch()) ?? empty) }
  })
  t.mock.method(yandex, 'getWaveTracks', async (_token: string, _sessionId: string, queue: string[]) => {
    queues.push(queue)
    return nextBatch()
  })
  t.mock.method(yandex, 'openTrackStream', async (_token: string, trackId: string) => {
    streamRequests.push(trackId)
    if (options.streamDelay) {
      await sleep(options.streamDelay)
    }

    let file: string | null = { short: shortClip, long: longClip, compact: compactClip }[options.clip ?? 'short']
    if (options.streamFile) {
      file = options.streamFile(trackId)
    } else if (options.brokenTracks?.includes(trackId)) {
      // Поток с ошибкой чтения, как оборванная загрузка
      file = path.join(dir, 'missing.wav')
    }
    return file === null ? null : fs.createReadStream(file)
  })
  t.mock.method(yandex, 'sendWaveFeedback', async (_token: string, sessionId: string, item: WaveFeedback) => {
    feedback.push({ sessionId, item })
    return true
  })

  const started = (id: string) =>
    feedback.filter(({ item }) => item.type === 'trackStarted' && item.trackId === `${id}:100`).length
  return { feedback, sessions, queues, streamRequests, started }
}

/**
 * Загрузка длинного клипа, которая отвечает с задержкой: успеваем увидеть плеер, пока трек загружается
 */
function slowLongClip(t: TestContext) {
  t.mock.method(yandex, 'openTrackStream', async () => {
    await sleep(400)
    return fs.createReadStream(longClip)
  })
}

function startedSession(t: TestContext, choice: WaveChoice = {}) {
  const test = createTestSession(FAST_TIMINGS, choice)
  t.after(() => test.session.destroy('Конец теста'))
  return test
}

async function waitForStart(session: WaveSession, started: (id: string) => number, id: string) {
  await waitFor(() => session.currentTrack?.id === id && started(id) === 1, `трек ${id} начал играть`)
}

/**
 * Фидбэк в виде «сессия событие трек», например «s1 trackStarted 11:100»
 */
function describeFeedback(feedback: { sessionId: string; item: WaveFeedback }[]): string[] {
  return feedback.map(({ sessionId, item }) =>
    'trackId' in item ? `${sessionId} ${item.type} ${item.trackId}` : `${sessionId} ${item.type}`
  )
}

const batch = (batchId: string, ...ids: string[]): IStationBatch => ({ batchId, tracks: ids.map(id => track(id)) })

const ACTIVE: WaveChoice = { moodEnergy: { seed: 'settingMoodEnergy:active', name: 'Бодрое' } }
const WORKOUT_ACTIVE: WaveChoice = {
  activity: { seed: 'activity:workout', name: 'Тренируюсь' },
  moodEnergy: { seed: 'settingMoodEnergy:active', name: 'Бодрое' }
}

describe('WaveSession', () => {
  it('играет волну по порядку и отправляет фидбэк в сессию волны', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12')] })
    const { session } = startedSession(t)

    assert.equal(await session.start(), true)
    assert.equal(session.currentTrack?.id, '11')
    assert.deepEqual(
      yandexStub.sessions,
      [{ seeds: ['user:onyourwave'], queue: [] }],
      'первая волна создаётся без queue'
    )

    await waitForStart(session, yandexStub.started, '12')

    assert.deepEqual(describeFeedback(yandexStub.feedback), [
      's1 radioStarted',
      's1 trackStarted 11:100',
      's1 trackFinished 11:100',
      's1 trackStarted 12:100'
    ])
    const finished = yandexStub.feedback.find(({ item }) => item.type === 'trackFinished')?.item
    assert.equal(finished && 'batchId' in finished ? finished.batchId : null, 'b1')
  })

  it('⏭️ сразу глушит трек, показывает загрузку и шлёт skip', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12')], clip: 'long' })
    const { session, edits } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')

    slowLongClip(t)
    const skipping = session.skip()
    await sleep(150)
    assert.equal(playerStatus(session), 'idle', 'текущий трек заглушён до загрузки следующего')
    assert.equal(embedDescription(edits.at(-1)), 'Загрузка трека...')
    await skipping

    assert.equal(session.currentTrack?.id, '12')
    assert.ok(
      yandexStub.feedback.some(({ item }) => item.type === 'skip' && item.trackId === '11:100' && item.batchId === 'b1')
    )
  })

  it('следующая партия запрашивается у той же сессии с queue последних треков', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12'), batch('b2', '21', '22')], clip: 'long' })
    const { session } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await session.skip()
    await waitForStart(session, yandexStub.started, '12')
    await session.skip()

    assert.equal(session.currentTrack?.id, '21')
    assert.equal(yandexStub.sessions.length, 1)
    assert.deepEqual(yandexStub.queues, [['11:100', '12:100']])
  })

  it('если Яндекс Музыка завершила сессию, создаётся новая с теми же настройками', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11'), null, batch('b2', '21')], clip: 'long' })
    const { session } = startedSession(t, ACTIVE)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await session.skip()
    await waitForStart(session, yandexStub.started, '21')

    assert.deepEqual(yandexStub.sessions, [
      { seeds: ['user:onyourwave', 'settingMoodEnergy:active'], queue: [] },
      { seeds: ['user:onyourwave', 'settingMoodEnergy:active'], queue: ['11:100'] }
    ])
    assert.deepEqual(describeFeedback(yandexStub.feedback), [
      's1 radioStarted',
      's1 trackStarted 11:100',
      's1 skip 11:100',
      's2 radioStarted',
      's2 trackStarted 21:100'
    ])
  })

  it('смена настроек сразу включает первый трек новой волны', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12'), batch('b2', '21', '22')], clip: 'long' })
    const { session, edits } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')

    assert.equal(await session.retune(WORKOUT_ACTIVE), true)
    assert.equal(session.currentTrack?.id, '21', 'не ждём конца текущего трека')
    assert.deepEqual(session.waveChoice, WORKOUT_ACTIVE)
    assert.deepEqual(yandexStub.sessions[1], {
      seeds: ['activity:workout', 'settingMoodEnergy:active'],
      queue: ['11:100']
    })

    await waitForStart(session, yandexStub.started, '21')
    // Прерванный трек засчитывается прежней волне как пропуск, как в клиенте Яндекс Музыки
    assert.deepEqual(describeFeedback(yandexStub.feedback), [
      's1 radioStarted',
      's1 trackStarted 11:100',
      's2 radioStarted',
      's1 skip 11:100',
      's2 trackStarted 21:100'
    ])
    await waitFor(
      () => embedDescription(edits.at(-1))?.endsWith('\nВолна: Тренируюсь · Бодрое') ?? false,
      'плеер показал настройки волны'
    )

    // Дальше играет новая волна, а ⏮️ по-прежнему возвращает прерванный трек
    await session.skip()
    assert.equal(session.currentTrack?.id, '22')
    assert.equal(await session.previous(), 'ok')
    assert.equal(await session.previous(), 'ok')
    assert.equal(session.currentTrack?.id, '11')
  })

  it('кнопка сброса настроек есть, только пока у волны есть настройки', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12'), batch('b2', '21', '22')], clip: 'long' })
    const { session, edits } = startedSession(t, ACTIVE)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await waitFor(() => buttons(edits.at(-1)).like, 'плеер показал трек')
    assert.equal(buttons(edits.at(-1)).reset, true)

    assert.equal(await session.retune({}), true)
    assert.deepEqual(yandexStub.sessions[1].seeds, ['user:onyourwave'])
    await waitFor(
      () => buttons(edits.at(-1)).like && !('reset' in buttons(edits.at(-1))),
      'кнопка сброса пропала вместе с настройками'
    )
    assert.ok(!embedDescription(edits.at(-1))?.includes('Волна:'))
  })

  it('подборка карусели играет со своими сидами, а плеер показывает её название', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12'), batch('b2', '21', '22')], clip: 'long' })
    const { session, edits } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')

    const wave = { seeds: ['genre:electronics', 'local-language:instrumental'], name: 'Электроника без слов' }
    assert.equal(await session.retune({ wave }), true)
    assert.deepEqual(yandexStub.sessions[1].seeds, ['genre:electronics', 'local-language:instrumental'])
    await waitFor(
      () => embedDescription(edits.at(-1))?.endsWith('\nВолна: Электроника без слов') ?? false,
      'плеер показал подборку'
    )
    assert.equal(buttons(edits.at(-1)).reset, true, 'с подборки можно вернуться к обычной «Моей волне»')
  })

  it('если новую волну получить не удалось, играет прежняя', async t => {
    let calls = 0
    const yandexStub = stubYandex(t, {
      clip: 'long',
      nextBatch: async () => {
        if (++calls === 1) {
          return batch('b1', '11', '12')
        }
        throw new Error('ECONNRESET')
      }
    })
    const { session } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')

    assert.equal(await session.retune(ACTIVE), false)
    assert.equal(session.currentTrack?.id, '11')
    assert.equal(playerStatus(session), 'playing')
    assert.deepEqual(session.waveChoice, {})
    assert.ok(!yandexStub.feedback.some(({ item }) => item.type === 'skip'))

    await session.skip()
    assert.equal(session.currentTrack?.id, '12', 'очередь прежней волны не тронута')
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

    assert.equal(yandexStub.streamRequests.filter(id => id === '11').length, 3)
    assert.ok(!yandexStub.feedback.some(({ item }) => 'trackId' in item && item.trackId === '11:100'))
  })

  it('кнопки ⏮️, 👍 и ⏸️ выключены, пока ими нельзя воспользоваться', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12')], clip: 'long' })
    const { session, edits } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await waitFor(() => buttons(edits.at(-1)).like, 'плеер показал трек')
    assert.deepEqual(buttons(edits.at(-1)), {
      like: true,
      previous: false,
      pause: true,
      stop: true,
      next: true,
      settings: true,
      carousel: true
    })

    slowLongClip(t)
    const skipping = session.skip()
    await sleep(150)
    assert.deepEqual(buttons(edits.at(-1)), {
      like: false,
      previous: true,
      pause: false,
      stop: true,
      next: true,
      settings: true,
      carousel: true
    })
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
      nextBatch: async () => {
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
      nextBatch: async () => batch('b', String(++id), String(++id)),
      streamFile: () => null
    })
    const { session } = startedSession(t)

    assert.equal(await session.start(), false)
    assert.equal(yandexStub.streamRequests.length, 5)
    assert.match(session.stopReason ?? '', /несколько треков подряд/)
  })

  it('если API волны недоступен, после трёх попыток плеер останавливается', async t => {
    const yandexStub = stubYandex(t, {
      nextBatch: async () => {
        throw new Error('ECONNRESET')
      }
    })
    const { session } = startedSession(t)

    assert.equal(await session.start(), false)
    assert.equal(yandexStub.sessions.length, 3)
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

  it('⏭️ и ⏹️ завершают ffmpeg, даже если файл трека уже целиком передан ему', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12')], clip: 'compact' })
    const { session } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await session.skip()
    await waitFor(() => runningProcesses() <= 1, 'ffmpeg пропущенного трека завершился')

    await waitForStart(session, yandexStub.started, '12')
    await session.destroy('Плеер был остановлен.')
    await waitFor(() => runningProcesses() === 0, 'ffmpeg завершился вместе с плеером')
  })
})
