import {
  DAVESession,
  NetworkingStatusCode,
  VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionState,
  VoiceConnectionStatus
} from '@discordjs/voice'

import { Logger } from '../utils/logger.js'

// Префикс отладочных сообщений DAVE (сквозного шифрования голоса) в логе голосового соединения
const DAVE_DEBUG_PREFIX = '[NW] [DAVE] '
// Сбои DAVE: коммит или welcome не обработан, смена ключей пропущена, звук остался без сквозного шифрования
const DAVE_FAILURE = /errored|Invalidating|don't have a pending|downgraded/
// Голосовой сервер выполняет смену ключей, о которой бот не знает: он пропустил коммит MLS
const MISSED_TRANSITION = "Received execute transition, but we don't have a pending transition"
// Пакет IP discovery: тип (1 — запрос, 2 — ответ), длина остатка, SSRC, адрес строкой в 64 байтах и порт
const DISCOVERY_SIZE = 74
const DISCOVERY_REQUEST = 1
const DISCOVERY_RESPONSE = 2

/**
 * Сообщение DAVE из отладочного лога голосового соединения или null. Остальные отладочные сообщения @discordjs/voice
 * в лог не выводим: в них токен голосового сервера и ключ шифрования звука
 */
export function daveDebugMessage(message: string): string | null {
  return message.startsWith(DAVE_DEBUG_PREFIX) ? message.slice(DAVE_DEBUG_PREFIX.length) : null
}

/**
 * Сообщения DAVE — в лог, сбои — предупреждением. По ним видно, что было со сквозным шифрованием,
 * если бота перестало быть слышно
 */
export function logDaveMessage(log: Logger, message: string): void {
  const dave = daveDebugMessage(message)
  if (dave && DAVE_FAILURE.test(dave)) {
    log.warn(`DAVE: ${dave}`)
  } else if (dave) {
    log.info(`DAVE: ${dave}`)
  }
}

/**
 * Бот пропустил коммит MLS: остальные участники перешли на новые ключи, а бот шифрует звук прежним, и его не слышно
 */
export function isMissedTransition(message: string): boolean {
  return daveDebugMessage(message)?.startsWith(MISSED_TRANSITION) ?? false
}

/**
 * Начало возобновления (resume): оборвался веб-сокет голосового сервера, и @discordjs/voice переподключает его
 * к прежней сессии. Новое соединение с голосовым сервером (смена сервера, переподключение) сюда не относится
 */
export function isResuming(oldState: VoiceConnectionState, newState: VoiceConnectionState): boolean {
  return (
    oldState.status === VoiceConnectionStatus.Ready &&
    newState.status === VoiceConnectionStatus.Connecting &&
    oldState.networking === newState.networking
  )
}

/**
 * Почему бота может быть не слышно, хотя плеер играет; null, если с соединением всё в порядке.
 * Отключение от канала сюда не входит: его разбирает сессия
 */
export function voiceProblem(connection: VoiceConnection): string | null {
  const { status } = connection.state
  if (status === VoiceConnectionStatus.Signalling || status === VoiceConnectionStatus.Connecting) {
    return 'голосовое соединение не восстанавливается'
  }

  const dave = daveSession(connection)
  // Пока сессия не готова, бот шлёт звук без сквозного шифрования, а клиенты Discord такой звук отбрасывают
  if (dave && (!dave.session?.ready || dave.reinitializing)) {
    return 'не готово сквозное шифрование голоса (DAVE)'
  }
  return null
}

/**
 * Голосовой сервер не ответил на heartbeat за timeout мс: веб-сокет голосового соединения, скорее всего, завис,
 * например на маршруте VPN, который перестал работать. Обычно ответ приходит за доли секунды
 */
export function isVoiceSocketStalled(connection: VoiceConnection, timeout: number, now = Date.now()): boolean {
  const { state } = connection
  if (state.status !== VoiceConnectionStatus.Ready || state.networking.state.code !== NetworkingStatusCode.Ready) {
    return false
  }

  // Время отправки heartbeat и ответа на него @discordjs/voice хранит, но в типах не открывает
  const ws = state.networking.state.ws as unknown as { lastHeartbeatSend?: number; lastHeartbeatAck?: number }
  const sent = ws.lastHeartbeatSend ?? 0
  const acknowledged = ws.lastHeartbeatAck ?? 0
  return sent > 0 && acknowledged < sent && now - sent > timeout
}

/**
 * Бот в группе сквозного шифрования, и его ключи согласованы с остальными участниками
 */
export function isDaveActive(connection: VoiceConnection): boolean {
  const dave = daveSession(connection)
  return !!dave?.session?.ready && !dave.reinitializing
}

/**
 * Адрес, с которого голосовой сервер Discord получает звук бота: ответ на запрос IP discovery по UDP,
 * как при подключении. Если UDP-туннель VPN перестроится через другой сервер, адрес сменится, хотя веб-сокет
 * голосового соединения жив. null — соединение не готово или сервер не ответил за timeout мс
 */
export function discoverVoiceAddress(connection: VoiceConnection, timeout: number): Promise<string | null> {
  const { state } = connection
  if (state.status !== VoiceConnectionStatus.Ready || state.networking.state.code !== NetworkingStatusCode.Ready) {
    return Promise.resolve(null)
  }

  const { udp, connectionData } = state.networking.state
  const request = Buffer.alloc(DISCOVERY_SIZE)
  request.writeUInt16BE(DISCOVERY_REQUEST, 0)
  request.writeUInt16BE(DISCOVERY_SIZE - 4, 2)
  request.writeUInt32BE(connectionData.ssrc, 4)

  return new Promise(resolve => {
    const onMessage = (message: Buffer) => {
      if (
        message.length !== DISCOVERY_SIZE ||
        message.readUInt16BE(0) !== DISCOVERY_RESPONSE ||
        message.readUInt32BE(4) !== connectionData.ssrc
      ) {
        return
      }
      const end = message.indexOf(0, 8)
      const ip = message.subarray(8, end === -1 ? DISCOVERY_SIZE - 2 : end).toString('utf8')
      finish(`${ip}:${message.readUInt16BE(DISCOVERY_SIZE - 2)}`)
    }
    const finish = (address: string | null) => {
      clearTimeout(timer)
      udp.off('message', onMessage)
      resolve(address)
    }
    const timer = setTimeout(() => finish(null), timeout)

    udp.on('message', onMessage)
    try {
      udp.send(request)
    } catch {
      // Сокет уже закрыт: соединение меняется прямо сейчас
      finish(null)
    }
  })
}

/**
 * Состояние соединения для лога, у отключения — с причиной и кодом закрытия веб-сокета
 */
export function describeConnectionState(state: VoiceConnectionState): string {
  if (state.status !== VoiceConnectionStatus.Disconnected) {
    return state.status
  }

  const code = state.reason === VoiceConnectionDisconnectReason.WebSocketClose ? `, код ${state.closeCode}` : ''
  return `${state.status} (${VoiceConnectionDisconnectReason[state.reason]}${code})`
}

/**
 * Сессия DAVE готового соединения, если звук в нём шифруется сквозным шифрованием
 */
function daveSession(connection: VoiceConnection): DAVESession | null {
  const { state } = connection
  if (state.status !== VoiceConnectionStatus.Ready) {
    return null
  }

  const networking = state.networking.state
  const dave = 'dave' in networking ? networking.dave : undefined
  return dave && dave.protocolVersion > 0 ? dave : null
}
