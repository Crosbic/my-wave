import { ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js'

/**
 * Слеш-команда бота: описание для Discord и обработчик
 */
export interface Command {
  data: {
    name: string
    toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody
  }
  execute(interaction: ChatInputCommandInteraction): Promise<unknown>
}
