import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js'

import { LoginService } from '../services/login.service.js'

export const data = new SlashCommandBuilder().setName('login').setDescription('Войти в аккаунт Яндекс Музыки')

/**
 * Вход по коду: бот показывает код для ya.ru/device и сам замечает, когда вход подтверждён.
 * Повторный вход заменяет токен, поэтому истёкший токен можно заменить без /logout
 */
export async function execute(interaction: ChatInputCommandInteraction) {
  await LoginService.getInstance().start(interaction)
}
