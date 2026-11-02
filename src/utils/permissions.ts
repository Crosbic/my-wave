import { User } from 'discord.js'

import config from '../config.js'

/**
 * Глобальный администратор бота: его ID или username указан в переменной ADMINS
 */
export function isBotAdmin(user: User): boolean {
  return config.admins.includes(user.id) || config.admins.includes(user.username)
}
