import { ChatInputCommandInteraction, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'

import { DatabaseService } from '../services/database.service.js'
import { isBotAdmin } from '../utils/permissions.js'

export const data = new SlashCommandBuilder()
  .setName('allow-buttons')
  .setDescription('Включить/выключить публичный доступ к управлению плеером')
  .addBooleanOption(option => option.setName('enabled').setDescription('Включить или выключить').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

export async function execute(interaction: ChatInputCommandInteraction) {
  const isEnabled = interaction.options.getBoolean('enabled', true)
  const guildId = interaction.guildId

  if (!guildId) {
    await interaction.reply({
      content: 'Эта команда может быть использована только на сервере.',
      flags: MessageFlags.Ephemeral
    })
    return
  }

  // Команда доступна администраторам сервера и глобальным администраторам бота
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || false

  if (!isAdmin && !isBotAdmin(interaction.user)) {
    await interaction.reply({
      content:
        'У вас нет прав на выполнение этой команды. Она доступна только администраторам сервера и глобальным администраторам бота.',
      flags: MessageFlags.Ephemeral
    })
    return
  }

  DatabaseService.getInstance().setPublicButtonsAccess(guildId, isEnabled)

  await interaction.reply({
    content: isEnabled
      ? 'Публичный доступ к управлению плеером включен для этого сервера. Теперь любой пользователь в голосовом канале с ботом может управлять плеером.'
      : 'Публичный доступ к управлению плеером выключен для этого сервера. Только пользователь, запустивший воспроизведение, может управлять плеером.'
  })
}
