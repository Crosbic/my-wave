import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import {
  ApplicationCommand,
  ApplicationCommandType,
  Client,
  Collection,
  RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js'

import { commands } from '../src/commands/index.js'
import { syncCommands } from '../src/commands/sync.js'

const fakeClient = {} as Client

// В типах discord.js конструктор закрыт, но создать команду из данных API можно
const RegisteredCommand = ApplicationCommand as unknown as new (client: Client, data: object) => ApplicationCommand

/**
 * Команда в том виде, в каком её возвращает Discord после регистрации
 */
function registered(data: RESTPostAPIChatInputApplicationCommandsJSONBody, index: number): ApplicationCommand {
  return new RegisteredCommand(fakeClient, {
    ...data,
    id: String(index),
    application_id: 'application',
    version: '1',
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: data.default_member_permissions ?? null,
    // Значения, которые Discord подставляет сам, если команда их не задаёт
    nsfw: false,
    dm_permission: true,
    contexts: [0, 1, 2],
    integration_types: [0]
  })
}

function clientWith(remote: Collection<string, ApplicationCommand>) {
  const set = mock.fn(async () => remote)
  const client = { application: { commands: { fetch: async () => remote, set } } }
  return { client: client as unknown as Client<true>, set }
}

describe('синхронизация слеш-команд', () => {
  it('не перерегистрирует команды, если они не изменились', async () => {
    const remote = new Collection(
      commands.map((command, index) => [String(index), registered(command.data.toJSON(), index)])
    )
    const { client, set } = clientWith(remote)

    await syncCommands(client)

    assert.equal(set.mock.callCount(), 0)
  })

  it('регистрирует команды, если какой-то нет или описание изменилось', async () => {
    const remote = new Collection(
      commands.map((command, index) => [String(index), registered(command.data.toJSON(), index)])
    )
    remote.delete('0')
    const missing = clientWith(remote)
    await syncCommands(missing.client)
    assert.equal(missing.set.mock.callCount(), 1)

    const changed = new Collection(
      commands.map((command, index) => {
        const data = command.data.toJSON()
        return [String(index), registered(index === 0 ? { ...data, description: 'Старое описание' } : data, index)]
      })
    )
    const outdated = clientWith(changed)
    await syncCommands(outdated.client)
    assert.equal(outdated.set.mock.callCount(), 1)
  })
})
