import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js'

import { LoginService } from '../services/login.service.js'
import { launchWave } from '../services/wave-launch.js'
import { dismiss, respond } from '../utils/interactions.js'

export const data = new SlashCommandBuilder()
  .setName('my-wave')
  .setDescription('Воспроизвести треки из "Моя волна" в Яндекс Музыке')

/**
 * Волна запускается сразу, с последними настройками пользователя. Поменять их можно кнопками в плеере.
 * Если пользователь не вошёл в Яндекс Музыку или вход перестал действовать, бот предлагает войти,
 * а после входа запускает волну сам
 */
export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const result = await launchWave(interaction)
  if (result.status === 'started') {
    // Подтверждение не нужно: в канале уже появился плеер
    await dismiss(interaction)
  } else if (result.status === 'failed') {
    await respond(interaction, result.message)
  } else {
    await LoginService.getInstance().start(interaction, 'wave')
  }
}
