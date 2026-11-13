import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionState,
  VoiceConnectionStatus
} from '@discordjs/voice'

import { FakeVoiceConnection } from './helpers.js'
import { daveDebugMessage, describeConnectionState, voiceProblem } from '../src/services/voice-health.js'

describe('voice-health', () => {
  it('из отладочного лога соединения берутся только сообщения DAVE: в остальных токен и ключ шифрования', () => {
    assert.equal(
      daveDebugMessage('[NW] [DAVE] MLS commit processed (transition id: 3)'),
      'MLS commit processed (transition id: 3)'
    )
    assert.equal(daveDebugMessage('[NW] [WS] >> {"op":0,"d":{"token":"secret"}}'), null)
    assert.equal(daveDebugMessage('[NW] state change:\nfrom {"code":4}'), null)
  })

  it('бота не слышно, пока соединение не восстановлено или не готово сквозное шифрование', () => {
    const connection = new FakeVoiceConnection()
    const problem = () => voiceProblem(connection as unknown as VoiceConnection)
    assert.equal(problem(), null)

    connection.dave.session.ready = false
    assert.match(problem() ?? '', /DAVE/)
    connection.dave.protocolVersion = 0
    assert.equal(problem(), null, 'без сквозного шифрования его готовность не важна')

    connection.resume()
    assert.match(problem() ?? '', /не восстанавливается/)
  })

  it('отключение от канала в логе — с причиной и кодом закрытия', () => {
    const state = {
      status: VoiceConnectionStatus.Disconnected,
      reason: VoiceConnectionDisconnectReason.WebSocketClose,
      closeCode: 4014
    } as unknown as VoiceConnectionState
    assert.equal(describeConnectionState(state), 'disconnected (WebSocketClose, код 4014)')
  })
})
