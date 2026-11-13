import { EventEmitter } from 'events'
import fs from 'fs'
import { TestContext } from 'node:test'
import path from 'path'
import { setTimeout as sleep } from 'timers/promises'

import { Collection, ComponentType, Message, MessageEditOptions, VoiceBasedChannel } from 'discord.js'

import { AudioPlayer, NetworkingStatusCode, VoiceConnection, VoiceConnectionStatus } from '@discordjs/voice'

import config from '../src/config.js'
import { WaveSession, WaveTimings } from '../src/services/wave-session.js'
import { WaveChoice } from '../src/types/waveSettings.js'
import { IYandexTrack } from '../src/types/yandexTrack.js'

const TMP_ROOT = path.resolve('test/.tmp')

/**
 * Уникальный временный каталог внутри test/.tmp
 */
export function tempDir(name: string): string {
  const dir = path.join(TMP_ROOT, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/**
 * WAV-файл с тишиной: ffmpeg читает его так же, как файл трека. По умолчанию в формате выхода ffmpeg
 * (48 кГц, стерео, 16 бит), а 8 кГц моно 8 бит в 24 раза компактнее выхода, как MP3
 */
export function writeSilentWav(
  file: string,
  seconds: number,
  { sampleRate = 48_000, channels = 2, bits = 16 } = {}
): string {
  const blockAlign = channels * (bits / 8)
  const dataSize = Math.round(seconds * sampleRate) * blockAlign
  // Тишина в 8-битном WAV — 128, в 16-битном — 0
  const buffer = Buffer.alloc(44 + dataSize, bits === 8 ? 128 : 0)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bits, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  fs.writeFileSync(file, buffer)
  return file
}

export function track(id: string, durationMs = 500): IYandexTrack {
  return {
    id,
    title: `Track ${id}`,
    artists: [{ name: 'Artist' }],
    albums: [{ id: 100, title: 'Album' }],
    coverUri: '',
    durationMs
  }
}

/**
 * Сессия сквозного шифрования (DAVE) голосового соединения: сессии важно, готова ли она
 */
export interface FakeDave {
  protocolVersion: number
  reinitializing: boolean
  session: { ready: boolean }
}

interface FakeConnectionState {
  status: VoiceConnectionStatus
  networking?: { state: { code: NetworkingStatusCode; dave: FakeDave } }
}

interface FakeJoinConfig {
  channelId: string | null
  selfDeaf: boolean
  selfMute: boolean
}

interface FakeSubscription {
  unsubscribe(): void
}

/**
 * Голосовое соединение без сети: плееру достаточно, что оно в состоянии Ready и принимает пакеты.
 * Выход из канала и повторный вход ведут себя как в VoiceConnection, а состояние соединения меняет тест
 */
export class FakeVoiceConnection extends EventEmitter {
  state: FakeConnectionState = { status: VoiceConnectionStatus.Ready, networking: fakeNetworking() }
  joinConfig: FakeJoinConfig & { guildId: string } = {
    channelId: 'voice-1',
    guildId: 'guild-1',
    selfDeaf: true,
    selfMute: false
  }
  disconnects = 0
  rejoins: FakeJoinConfig[] = []
  private subscription: FakeSubscription | undefined

  // Сессия DAVE текущего соединения с голосовым сервером
  get dave(): FakeDave {
    return this.state.networking!.state.dave
  }

  subscribe(player: AudioPlayer) {
    this.subscription = (player as unknown as { subscribe(connection: unknown): FakeSubscription }).subscribe(this)
    return this.subscription
  }

  onSubscriptionRemoved(subscription: FakeSubscription) {
    if (this.subscription === subscription) {
      this.subscription = undefined
    }
  }

  prepareAudioPacket() {}

  dispatchAudio() {
    return true
  }

  setSpeaking() {}

  // Как VoiceConnection: выходит из канала и отписывает плеер, а пока соединение ещё не начато, ничего не делает
  disconnect() {
    if (
      this.state.status === VoiceConnectionStatus.Destroyed ||
      this.state.status === VoiceConnectionStatus.Signalling
    ) {
      return false
    }

    this.disconnects++
    this.joinConfig.channelId = null
    this.subscription?.unsubscribe()
    this.setState({ status: VoiceConnectionStatus.Disconnected })
    return true
  }

  rejoin(config: FakeJoinConfig) {
    if (this.state.status === VoiceConnectionStatus.Destroyed) {
      return false
    }

    this.rejoins.push({ ...config })
    Object.assign(this.joinConfig, config)
    if (this.state.status !== VoiceConnectionStatus.Ready) {
      this.setState({ status: VoiceConnectionStatus.Signalling })
    }
    return true
  }

  // Оборвался веб-сокет голосового сервера, и @discordjs/voice возобновляет прежнее соединение
  resume() {
    this.setState({ status: VoiceConnectionStatus.Connecting, networking: this.state.networking })
  }

  // Новое соединение с голосовым сервером готово
  ready() {
    this.setState({ status: VoiceConnectionStatus.Ready, networking: fakeNetworking() })
  }

  setState(newState: FakeConnectionState) {
    const oldState = this.state
    this.state = newState
    this.emit('stateChange', oldState, newState)
    if (oldState.status !== newState.status) {
      this.emit(newState.status, oldState, newState)
    }
  }

  destroy() {
    this.setState({ status: VoiceConnectionStatus.Destroyed })
  }
}

function fakeNetworking() {
  const dave: FakeDave = { protocolVersion: 1, reinitializing: false, session: { ready: true } }
  return { state: { code: NetworkingStatusCode.Ready, dave } }
}

// Ускоренные тайминги: проверка активности отключена, повторы и подтверждение старта — быстрые
export const FAST_TIMINGS: Partial<WaveTimings> = {
  activityCheckInterval: 60_000,
  retryDelay: 30,
  startConfirmDelay: 100
}

export interface TestSession {
  session: WaveSession
  connection: FakeVoiceConnection
  edits: MessageEditOptions[]
  isDestroyed(): boolean
}

export function createTestSession(timings: Partial<WaveTimings> = FAST_TIMINGS, choice: WaveChoice = {}): TestSession {
  const edits: MessageEditOptions[] = []
  const message = {
    id: 'message-1',
    edit: async (options: MessageEditOptions) => {
      edits.push(options)
      return message
    }
  }
  const guild = {
    id: 'guild-1',
    client: { user: { id: 'bot' } },
    voiceStates: {
      cache: new Collection([['owner', { id: 'owner', channelId: 'voice-1', member: { user: { bot: false } } }]])
    }
  }
  const connection = new FakeVoiceConnection()
  let destroyed = false

  const session = new WaveSession(
    {
      voiceChannel: { guild } as unknown as VoiceBasedChannel,
      textChannel: {} as never,
      owner: { discordId: 'owner', yandexId: 'yandex-owner', accessToken: 'token' },
      choice,
      onDestroy: () => (destroyed = true),
      timings
    },
    connection as unknown as VoiceConnection,
    message as unknown as Message
  )

  return { session, connection, edits, isDestroyed: () => destroyed }
}

/**
 * Состояние кнопок в сообщении: действие -> доступна ли кнопка
 */
export function buttons(options: MessageEditOptions | undefined): Record<string, boolean> {
  const rows = (options?.components ?? []) as unknown as readonly {
    toJSON(): { components: { custom_id: string; disabled?: boolean }[] }
  }[]
  return Object.fromEntries(
    rows
      .flatMap(row => row.toJSON().components)
      .map(button => [button.custom_id.replace('wave:', ''), !button.disabled])
  )
}

interface ComponentJson {
  type: number
  content?: string
  custom_id?: string
  label?: string
  disabled?: boolean
  components?: ComponentJson[]
  accessory?: ComponentJson
}

/**
 * Панель из компонентов V2 так, как её увидит пользователь: тексты, секции (текст и customId кнопки рядом с ним)
 * и кнопки в рядах: customId, подпись и доступна ли кнопка
 */
export function readComponentsPanel(components: readonly unknown[] | undefined) {
  const texts: string[] = []
  const sections: { text: string; button?: string }[] = []
  const buttons: { id?: string; label?: string; enabled: boolean }[] = []

  const visit = (component: ComponentJson): void => {
    if (component.type === ComponentType.TextDisplay) {
      texts.push(component.content ?? '')
    } else if (component.type === ComponentType.Section) {
      const text = (component.components ?? []).map(item => item.content).join('\n')
      sections.push({ text, button: component.accessory?.custom_id })
    } else if (component.type === ComponentType.Button) {
      buttons.push({ id: component.custom_id, label: component.label, enabled: !component.disabled })
    } else {
      component.components?.forEach(visit)
    }
  }

  // Через JSON, как при отправке в Discord: билдеры превращаются в объекты API
  const json = JSON.parse(JSON.stringify(components ?? [])) as ComponentJson[]
  json.forEach(visit)
  return { texts, sections, buttons }
}

export function embedDescription(options: MessageEditOptions | undefined): string | undefined {
  const embeds = (options?.embeds ?? []) as unknown as readonly { toJSON(): { description?: string } }[]
  return embeds[0]?.toJSON().description
}

export interface LogLine {
  level: 'info' | 'warn' | 'error'
  line: string
}

/**
 * Строки лога, выведенные за время теста: уровень логов на это время info, вывод в консоль подменён
 */
export function captureLogs(t: TestContext): LogLine[] {
  const lines: LogLine[] = []
  const level = config.logLevel
  config.logLevel = 'info'
  t.after(() => {
    config.logLevel = level
  })

  const targets = [
    ['log', 'info'],
    ['warn', 'warn'],
    ['error', 'error']
  ] as const
  for (const [method, logLevel] of targets) {
    t.mock.method(console, method, (line: unknown) => lines.push({ level: logLevel, line: String(line) }))
  }
  return lines
}

export async function waitFor(predicate: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error(`Не дождались: ${label}`)
    }
    await sleep(20)
  }
}

/**
 * Состояние настоящего AudioPlayer внутри сессии
 */
export function playerStatus(session: WaveSession): string {
  return (session as unknown as { player: AudioPlayer }).player.state.status
}

/**
 * Сколько дочерних процессов (ffmpeg) ещё работает. Каждый держит процесс теста: node --test не завершится, пока они живы
 */
export function runningProcesses(): number {
  return process.getActiveResourcesInfo().filter(type => type === 'ProcessWrap').length
}
