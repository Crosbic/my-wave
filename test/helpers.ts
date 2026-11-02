import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { setTimeout as sleep } from 'timers/promises'

import { Collection, Message, MessageEditOptions, VoiceBasedChannel } from 'discord.js'

import { AudioPlayer, VoiceConnection, VoiceConnectionStatus } from '@discordjs/voice'

import { WaveSession, WaveTimings } from '../src/services/wave-session.js'
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
 * WAV-файл с тишиной: ffmpeg читает его так же, как ссылку на трек
 */
export function writeSilentWav(file: string, seconds: number): string {
  const sampleRate = 48_000
  const channels = 2
  const dataSize = Math.round(seconds * sampleRate) * channels * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * 2, 28)
  buffer.writeUInt16LE(channels * 2, 32)
  buffer.writeUInt16LE(16, 34)
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
 * Голосовое соединение без сети: плееру достаточно, что оно в состоянии Ready и принимает пакеты
 */
export class FakeVoiceConnection extends EventEmitter {
  state: { status: VoiceConnectionStatus } = { status: VoiceConnectionStatus.Ready }
  joinConfig = { channelId: 'voice-1', guildId: 'guild-1' }

  subscribe(player: AudioPlayer) {
    return (player as unknown as { subscribe(connection: unknown): unknown }).subscribe(this)
  }

  prepareAudioPacket() {}

  dispatchAudio() {
    return true
  }

  setSpeaking() {}

  destroy() {
    const oldState = this.state
    this.state = { status: VoiceConnectionStatus.Destroyed }
    this.emit('stateChange', oldState, this.state)
    this.emit(VoiceConnectionStatus.Destroyed, oldState, this.state)
  }
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

export function createTestSession(timings: Partial<WaveTimings> = FAST_TIMINGS): TestSession {
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
      stationId: 'user:onyourwave',
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

export function embedDescription(options: MessageEditOptions | undefined): string | undefined {
  const embeds = (options?.embeds ?? []) as unknown as readonly { toJSON(): { description?: string } }[]
  return embeds[0]?.toJSON().description
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
