import * as accountInfo from './account-info.js'
import * as allowButtons from './allow-buttons.js'
import * as login from './login.js'
import * as logout from './logout.js'
import * as myWave from './my-wave.js'
import * as ping from './ping.js'
import { Command } from '../types/command.js'

/**
 * Все слеш-команды бота. Новую команду достаточно добавить в этот список:
 * при следующем запуске бот сам зарегистрирует её в Discord
 */
export const commands: Command[] = [accountInfo, allowButtons, login, logout, myWave, ping]

export const commandsByName = new Map(commands.map(command => [command.data.name, command]))
