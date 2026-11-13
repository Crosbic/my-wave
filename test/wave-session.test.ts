import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, before, describe, it, TestContext } from 'node:test'
import path from 'path'
import { setTimeout as sleep } from 'timers/promises'

import { MessageEditOptions } from 'discord.js'

import { VoiceConnectionStatus } from '@discordjs/voice'

import {
  buttons,
  captureLogs,
  createTestSession,
  embedDescription,
  FAST_TIMINGS,
  FakeVoiceConnection,
  playerStatus,
  removeDir,
  runningProcesses,
  tempDir,
  track,
  waitFor,
  writeSilentWav
} from './helpers.js'
import { YandexAuthError } from '../src/errors/yandexAuthError.js'
import { WaveSession, WaveTimings } from '../src/services/wave-session.js'
import { WaveFeedback, YandexMusicService } from '../src/services/yandex-music.service.js'
import { WaveChoice } from '../src/types/waveSettings.js'
import { IStationBatch, IYandexTrack } from '../src/types/yandexTrack.js'

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

function startedSession(t: TestContext, choice: WaveChoice = {}, timings: Partial<WaveTimings> = {}) {
  const test = createTestSession({ ...FAST_TIMINGS, ...timings }, choice)
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
const ids = (tracks: IYandexTrack[]) => tracks.map(item => item.id)
const showsTrack = (options: MessageEditOptions | undefined, id: string) =>
  embedDescription(options)?.startsWith(`**Track ${id}**`) ?? false

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

  it('трек из истории сразу играет, текущий уходит в историю, а волна продолжается', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12', '13'), batch('b2', '21')], clip: 'long' })
    const { session } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await session.skip()
    await waitForStart(session, yandexStub.started, '12')
    await session.skip()
    await waitForStart(session, yandexStub.started, '13')
    assert.deepEqual(ids(session.recentTracks), ['12', '11'], 'последний сыгранный — первым')

    assert.equal(await session.playFromHistory('11'), 'ok')
    assert.equal(session.currentTrack?.id, '11')
    assert.deepEqual(ids(session.recentTracks), ['13', '12'])

    assert.equal(await session.playFromHistory('11'), 'ok', 'трек уже играет')
    assert.equal(await session.playFromHistory('99'), 'missing')
    assert.equal(session.currentTrack?.id, '11')

    await session.skip()
    await waitForStart(session, yandexStub.started, '21')
    assert.deepEqual(ids(session.recentTracks), ['11', '13', '12'], 'после выбранного трека играют новые треки волны')

    // Прерванный трек засчитывается волне как пропуск, а выбранный играет повторно и фидбэка не шлёт
    assert.deepEqual(describeFeedback(yandexStub.feedback), [
      's1 radioStarted',
      's1 trackStarted 11:100',
      's1 skip 11:100',
      's1 trackStarted 12:100',
      's1 skip 12:100',
      's1 trackStarted 13:100',
      's1 skip 13:100',
      's1 trackStarted 21:100'
    ])
  })

  it('⏮️ возвращает трек, который прервал выбор в истории', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12')], clip: 'long' })
    const { session, edits } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await session.skip()
    await waitForStart(session, yandexStub.started, '12')

    // Единственный трек истории уходит из неё, а прерванный приходит на его место: кнопки остаются доступны
    assert.equal(await session.playFromHistory('11'), 'ok')
    await waitFor(() => {
      const last = edits.at(-1)
      return showsTrack(last, '11') && buttons(last).previous && buttons(last).history
    }, 'плеер показал выбранный трек, ⏮️ и 📜 доступны')

    assert.equal(await session.previous(), 'ok')
    assert.equal(session.currentTrack?.id, '12')
  })

  it('после ⏮️ в истории есть и треки, к которым вернёт ⏭️, и их можно выбрать', async t => {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12', '13')], clip: 'long' })
    const { session, edits } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await session.skip()
    await waitForStart(session, yandexStub.started, '12')
    await session.skip()
    await waitForStart(session, yandexStub.started, '13')
    assert.equal(await session.previous(), 'ok')
    assert.equal(await session.previous(), 'ok')

    assert.equal(session.currentTrack?.id, '11')
    assert.deepEqual(ids(session.recentTracks), ['12', '13'], '12 прерван последним')
    // Раньше 11 ничего не играло, но в истории есть треки, к которым вернёт ⏭️
    await waitFor(() => {
      const last = edits.at(-1)
      return showsTrack(last, '11') && !buttons(last).previous && buttons(last).history
    }, '⏮️ выключена, а 📜 доступна')

    assert.equal(await session.playFromHistory('13'), 'ok')
    assert.deepEqual(ids(session.recentTracks), ['11', '12'])
    await session.skip()
    assert.equal(session.currentTrack?.id, '12', '⏭️ ведёт к оставшемуся после ⏮️ треку')
  })

  it('если трек из истории не запустился, играет прежний, а история не меняется', async t => {
    let unavailable = false
    const yandexStub = stubYandex(t, {
      batches: [batch('b1', '11', '12')],
      streamFile: id => (unavailable && id === '11' ? null : longClip)
    })
    const { session } = startedSession(t)

    await session.start()
    await waitForStart(session, yandexStub.started, '11')
    await session.skip()
    await waitForStart(session, yandexStub.started, '12')

    unavailable = true
    assert.equal(await session.playFromHistory('11'), 'failed')
    assert.equal(session.currentTrack?.id, '12')
    assert.equal(playerStatus(session), 'playing')
    assert.deepEqual(ids(session.recentTracks), ['11'])
    assert.ok(!yandexStub.feedback.some(({ item }) => item.type === 'skip' && item.trackId === '12:100'))
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

  it('кнопки ⏮️, 📜, 👍 и ⏸️ выключены, пока ими нельзя воспользоваться', async t => {
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
      history: false,
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
      history: true,
      settings: true,
      carousel: true
    })
    await skipping
    await waitFor(() => buttons(edits.at(-1)).like, 'плеер показал следующий трек')
    assert.equal(buttons(edits.at(-1)).previous, true)
    assert.equal(buttons(edits.at(-1)).history, true)
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

  it('обычная остановка плеера в логе — info, а сбой — error', async t => {
    const logs = captureLogs(t)
    const stops = () => logs.filter(({ line }) => line.includes('Плеер остановлен')).map(({ level }) => level)

    await startedSession(t).session.destroy('Плеер был остановлен.')
    assert.deepEqual(stops(), ['info'])

    stubYandex(t, {
      nextBatch: async () => {
        throw new Error('ECONNRESET')
      }
    })
    assert.equal(await startedSession(t).session.start(), false)
    assert.deepEqual(stops(), ['info', 'error'])
    assert.ok(
      logs.some(({ level, line }) => level === 'warn' && line.includes('попытка 1/3')),
      'попытка, после которой будет следующая, — только предупреждение'
    )
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

describe('WaveSession: голосовое соединение', () => {
  // Соединение и шифрование проверяются часто, а зависшими считаются быстро
  const WATCHED: Partial<WaveTimings> = { activityCheckInterval: 50, voiceStallTimeout: 300 }
  const MISSED_TRANSITION = "[NW] [DAVE] Received execute transition, but we don't have a pending transition for 5"

  // Сколько раз бот просил Discord подключить его к каналу
  const joins = (connection: FakeVoiceConnection) => connection.rejoins.filter(config => config.channelId).length

  async function playingSession(t: TestContext, timings: Partial<WaveTimings> = {}) {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12')], clip: 'long' })
    const test = startedSession(t, {}, timings)
    await test.session.start()
    await waitForStart(test.session, yandexStub.started, '11')
    return test
  }

  it('после обрыва связи с голосовым сервером бот заходит в канал заново, а трек играет дальше', async t => {
    const { session, connection, isDestroyed } = await playingSession(t)

    connection.resume()
    await waitFor(() => connection.rejoins.length === 1, 'бот зашёл в канал заново')
    assert.equal(connection.disconnects, 1, 'сначала бот вышел из канала')
    assert.deepEqual(connection.rejoins, [{ channelId: 'voice-1', selfDeaf: true, selfMute: false }])
    await waitFor(() => playerStatus(session) === 'autopaused', 'пока соединения нет, трек на паузе')

    connection.ready()
    await waitFor(() => playerStatus(session) === 'playing', 'трек играет дальше')
    assert.equal(session.currentTrack?.id, '11', 'тот же трек, а не следующий')
    assert.ok(!isDestroyed())
  })

  it('если зайти в канал заново так и не удалось, плеер останавливается с понятной причиной', async t => {
    const { session, connection, isDestroyed } = await playingSession(t, {
      connectTimeout: 150,
      rejoinDelay: 20,
      voiceRecoveryTimeout: 500
    })

    connection.resume()
    await waitFor(isDestroyed, 'плеер остановлен')
    assert.equal(session.stopReason, 'Соединение с голосовым каналом потеряно.')
    assert.ok(joins(connection) >= 2, 'бот пробовал зайти в канал несколько раз')
  })

  it('пока шлюз Discord переподключается, бот пробует зайти в канал снова', async t => {
    const { session, connection, isDestroyed } = await playingSession(t, { rejoinDelay: 20 })

    // Запросы на вход в канал не уходят, пока шлюз Discord не переподключится
    connection.unavailable = 2
    connection.resume()
    await waitFor(
      () => connection.unavailable === 0 && connection.state.status === VoiceConnectionStatus.Signalling,
      'третья попытка дошла до Discord'
    )

    connection.ready()
    await waitFor(() => playerStatus(session) === 'playing', 'трек играет дальше')
    assert.equal(joins(connection), 3)
    assert.ok(!isDestroyed())
  })

  it('если голосовой сервер не отвечает на heartbeat, бот заходит в канал заново, не дожидаясь @discordjs/voice', async t => {
    const { connection } = await playingSession(t, { ...WATCHED, heartbeatTimeout: 300 })

    // На последний heartbeat сервер ответил
    connection.ws.lastHeartbeatSend = Date.now() - 1_000
    connection.ws.lastHeartbeatAck = Date.now() - 900
    await sleep(200)
    assert.equal(connection.rejoins.length, 0)

    // Новый heartbeat только что ушёл: ответа пока нет, но время ещё не вышло
    connection.ws.lastHeartbeatSend = Date.now()
    await sleep(150)
    assert.equal(connection.rejoins.length, 0)

    await waitFor(() => connection.rejoins.length === 1, 'бот зашёл в канал заново')
  })

  it('если сквозное шифрование долго не готово, бот заходит в канал заново', async t => {
    const { connection } = await playingSession(t, WATCHED)

    // При смене ключей шифрование ненадолго не готово, это не сбой
    connection.dave.session.ready = false
    await sleep(150)
    connection.dave.session.ready = true
    await sleep(450)
    assert.equal(connection.rejoins.length, 0)

    connection.dave.reinitializing = true
    await waitFor(() => connection.rejoins.length === 1, 'бот зашёл в канал заново')
  })

  it('если бот пропустил смену ключей шифрования, он заходит в канал заново', async t => {
    const { connection } = await playingSession(t)

    // Пока бот не в группе шифрования, смены ключей между остальными участниками его не касаются
    connection.dave.session.ready = false
    connection.emit('debug', MISSED_TRANSITION)
    await sleep(100)
    assert.equal(connection.rejoins.length, 0)

    connection.dave.session.ready = true
    connection.emit('debug', MISSED_TRANSITION)
    await waitFor(() => connection.rejoins.length === 1, 'бот зашёл в канал заново')
  })

  it('если соединение не восстанавливается само, бот выходит из канала и заходит снова', async t => {
    const { session, connection } = await playingSession(t, WATCHED)

    // После обрыва @discordjs/voice попросил Discord подключить бота заново, но ответа нет
    connection.setState({ status: VoiceConnectionStatus.Signalling })
    await waitFor(() => connection.rejoins.length === 2, 'бот зашёл в канал заново')
    assert.deepEqual(
      connection.rejoins.map(config => config.channelId),
      [null, 'voice-1']
    )

    connection.ready()
    await waitFor(() => playerStatus(session) === 'playing', 'трек играет дальше')
  })

  it('если соединение обрывается раз за разом, плеер останавливается', async t => {
    const { session, connection, isDestroyed } = await playingSession(t)

    for (let attempt = 1; attempt <= 5; attempt++) {
      connection.resume()
      await waitFor(() => connection.rejoins.length === attempt, `бот зашёл в канал заново (${attempt})`)
      connection.ready()
      await waitFor(() => playerStatus(session) === 'playing', `трек играет дальше (${attempt})`)
    }

    connection.resume()
    await waitFor(isDestroyed, 'плеер остановлен')
    assert.equal(session.stopReason, 'Соединение с голосовым каналом постоянно обрывается.')
    assert.equal(connection.rejoins.length, 5)
  })
})

describe('WaveSession: адрес, с которого Discord получает звук бота', () => {
  // Адрес сверяется часто, а ответа ждём недолго
  const UDP_CHECKED: Partial<WaveTimings> = { udpCheckInterval: 50, udpCheckTimeout: 50 }

  async function start(t: TestContext, prepare: (connection: FakeVoiceConnection) => void = () => {}) {
    const yandexStub = stubYandex(t, { batches: [batch('b1', '11', '12')], clip: 'long' })
    const test = startedSession(t, {}, UDP_CHECKED)
    prepare(test.connection)
    await test.session.start()
    await waitForStart(test.session, yandexStub.started, '11')
    return test
  }

  it('если UDP-туннель перестроился через другой сервер, бот заходит в канал заново', async t => {
    const { connection } = await start(t)
    await waitFor(() => connection.udp.requests >= 2, 'адрес сверен')
    assert.equal(connection.rejoins.length, 0, 'пока адрес прежний, всё в порядке')

    // Веб-сокет голосового соединения жив, а звук идёт в Discord уже с другого сервера VPN
    connection.udp.address = '198.51.100.7:41234'
    await waitFor(() => connection.rejoins.length === 1, 'бот зашёл в канал заново')

    connection.ready()
    await waitFor(() => connection.udp.requests >= 2, 'адрес нового соединения сверен')
    assert.equal(connection.rejoins.length, 1, 'в новом соединении адрес узнаётся заново')
  })

  it('если голосовой сервер не отвечает на проверку, она отключается, а бот играет дальше', async t => {
    const { session, connection } = await start(t, connection => {
      connection.udp.address = null
    })

    await waitFor(() => connection.udp.requests >= 3, 'три проверки без ответа')
    await sleep(300)
    assert.equal(connection.udp.requests, 3, 'больше адрес в этом соединении не проверяется')
    assert.equal(connection.rejoins.length, 0)
    assert.equal(playerStatus(session), 'playing')
  })
})
