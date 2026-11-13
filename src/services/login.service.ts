import { randomUUID } from 'crypto'
import { setTimeout as sleep } from 'timers/promises'

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  escapeMarkdown,
  Message,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  RepliableInteraction,
  TextInputStyle,
  time,
  TimestampStyles
} from 'discord.js'

import { DatabaseService } from './database.service.js'
import { PlayerService } from './player.service.js'
import { launchWave } from './wave-launch.js'
import { YandexMusicService } from './yandex-music.service.js'
import { DeviceCode, DeviceTokenResult, YandexOAuthService } from './yandex-oauth.service.js'
import { YandexAuthError } from '../errors/yandexAuthError.js'
import { IUserData, YandexTokens } from '../types/userData.js'
import { deleteLater, dismiss, LONG_NOTICE_TTL, respond, SHORT_NOTICE_TTL } from '../utils/interactions.js'
import { logger } from '../utils/logger.js'

export const LOGIN_PREFIX = 'login:'
// Способы получить токен, если вход по коду не подходит
const TOKEN_GUIDE_URL = 'https://ym.marshal.dev/token'
const TOKEN_INPUT_ID = 'token'
const STALE_NOTICE = 'Этот код больше не действует.'

const log = logger.child('login')

/**
 * Что сделать после входа: подтвердить его или сразу запустить волну, если вход начался с /my-wave.
 * Цель записана в id кнопок сообщения со входом, поэтому переживает и новый код, и перезапуск бота
 */
export type LoginGoal = 'login' | 'wave'

type LoginInteraction = ChatInputCommandInteraction | ButtonInteraction

interface LoginView {
  content: string
  components: ActionRowBuilder<ButtonBuilder>[]
}

interface PendingLogin {
  id: string
  interaction: LoginInteraction
  goal: LoginGoal
  // Сообщение с кодом, когда код уже показан
  messageId?: string
  abort: AbortController
}

type LoginOutcome = { ok: true; name: string; wasAuthorized: boolean } | { ok: false; message: string }

/**
 * Вход в Яндекс Музыку. Основной способ — по коду: бот показывает код, пользователь вводит его на ya.ru/device,
 * а бот сам замечает, что вход подтверждён. Запасной — токен, который пользователь вставляет в окно
 */
export class LoginService {
  private static instance: LoginService
  // У пользователя ждёт подтверждения не больше одного кода: новый код отменяет прежний
  private readonly pending = new Map<string, PendingLogin>()
  private readonly oauth = YandexOAuthService.getInstance()

  private constructor() {}

  public static getInstance(): LoginService {
    if (!LoginService.instance) {
      LoginService.instance = new LoginService()
    }
    return LoginService.instance
  }

  /**
   * Вход по коду из /login, /my-wave или по кнопке «Получить новый код».
   * Промис завершается вместе со входом: успехом, отказом, истечением кода или отменой
   */
  public async start(interaction: LoginInteraction, goal: LoginGoal = 'login'): Promise<void> {
    if (interaction.isButton()) {
      await interaction.deferUpdate()
    } else if (!interaction.deferred) {
      // /my-wave отвечает отложенно ещё до того, как становится ясно, что нужен вход
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    }

    const userId = interaction.user.id
    this.cancel(userId, interaction.isButton() ? interaction.message.id : undefined)

    const attempt: PendingLogin = { id: randomUUID(), interaction, goal, abort: new AbortController() }
    this.pending.set(userId, attempt)
    try {
      await this.waitForLogin(attempt)
    } finally {
      if (this.pending.get(userId) === attempt) {
        this.pending.delete(userId)
      }
    }
  }

  /**
   * Кнопки сообщения со входом и окно с токеном
   */
  public async handleInteraction(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<void> {
    // У «Отмены» после действия записан id попытки, у остальных кнопок и у окна — цель входа
    const [action, detail] = interaction.customId.slice(LOGIN_PREFIX.length).split(':')
    const goal: LoginGoal = detail === 'wave' ? 'wave' : 'login'
    try {
      if (interaction.isModalSubmit()) {
        await this.submitToken(interaction, goal)
      } else if (action === 'manual') {
        await interaction.showModal(tokenModal(goal))
      } else if (action === 'retry') {
        await this.start(interaction, goal)
      } else if (action === 'cancel') {
        // Кнопка из старого сообщения не должна отменять код, который показан в новом
        if (this.pending.get(interaction.user.id)?.id === detail) {
          this.cancel(interaction.user.id, interaction.message.id)
        }
        await interaction.update({ content: 'Вход отменён.', components: [] })
        deleteLater(interaction, '@original', SHORT_NOTICE_TTL)
      }
    } catch (error) {
      log.error(`Ошибка при обработке ${interaction.customId}`, error)
      await respond(interaction, 'Произошла ошибка при входе. Попробуйте ещё раз.')
    }
  }

  private async waitForLogin(attempt: PendingLogin): Promise<void> {
    const { interaction, goal, abort } = attempt
    const userId = interaction.user.id

    let code: DeviceCode
    try {
      code = await this.oauth.requestDeviceCode(userId)
    } catch (error) {
      log.error('Не удалось получить код для входа', error)
      await show(
        interaction,
        failedView('Не удалось получить код для входа от Яндекса. Попробуйте ещё раз или войдите по токену.', goal)
      )
      return
    }
    // Пока код запрашивался, пользователь запросил ещё один
    if (abort.signal.aborted) {
      await show(interaction, { content: STALE_NOTICE, components: [] })
      return
    }

    const expiresAt = Date.now() + code.expiresIn * 1000
    const current = DatabaseService.getInstance().getUserData(userId)?.userInfo
    attempt.messageId = (await show(interaction, codeView(code, expiresAt, attempt, current)))?.id
    log.info(`Код для входа выдан: ${interaction.user.tag}`)

    while (Date.now() < expiresAt) {
      try {
        await sleep(code.interval * 1000, undefined, { signal: abort.signal })
      } catch {
        // Вход отменён, и сообщение уже обновил тот, кто его отменил
        return
      }

      let result: DeviceTokenResult
      try {
        result = await this.oauth.pollDeviceToken(code.deviceCode)
      } catch (error) {
        // Сбой сети или Яндекса — не повод бросать вход: пока код действует, спрашиваем снова
        log.warn('Не удалось узнать, подтверждён ли вход', error)
        continue
      }
      if (abort.signal.aborted) {
        return
      }

      if (result.status === 'granted') {
        await this.complete(interaction, goal, await this.finishLogin(userId, result.tokens))
        return
      }
      if (result.status === 'denied') {
        await show(interaction, failedView('Вход отклонён на странице Яндекса.', goal))
        return
      }
      if (result.status === 'expired') {
        break
      }
    }

    log.info(`Код для входа истёк: ${interaction.user.tag}`)
    await show(interaction, failedView('Код истёк. Получите новый, чтобы войти.', goal))
  }

  private async submitToken(interaction: ModalSubmitInteraction, goal: LoginGoal): Promise<void> {
    if (interaction.isFromMessage()) {
      await interaction.deferUpdate()
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    }
    // Пользователь вставил токен, и код, который ждёт подтверждения, больше не нужен
    this.cancel(interaction.user.id, interaction.message?.id)

    const token = extractToken(interaction.fields.getTextInputValue(TOKEN_INPUT_ID))
    const outcome: LoginOutcome = token
      ? await this.finishLogin(interaction.user.id, { accessToken: token })
      : {
          ok: false,
          message: 'Это не похоже на токен. Вставьте сам токен или всю ссылку, в которой есть `access_token=`.'
        }
    await this.complete(interaction, goal, outcome)
  }

  /**
   * Проверяет токен и подписку и сохраняет токены
   */
  private async finishLogin(userId: string, tokens: YandexTokens): Promise<LoginOutcome> {
    let result
    try {
      result = await YandexMusicService.getInstance().getUserInfo(tokens.accessToken)
    } catch (error) {
      if (error instanceof YandexAuthError) {
        log.info(`Вход не выполнен: Яндекс не принял токен пользователя ${userId}`)
        return { ok: false, message: 'Токен недействителен или истёк.' }
      }
      log.error('Ошибка при авторизации', error)
      return {
        ok: false,
        message: 'Не удалось получить информацию о пользователе от Яндекса. Пожалуйста, попробуйте позже.'
      }
    }

    const { userInfo, hasPlus } = result
    if (!hasPlus) {
      log.info(`Вход не выполнен: у пользователя ${userId} нет подписки Яндекс Плюс`)
      // Токен, который Яндекс выдал боту, без подписки не нужен: отзываем его, чтобы бот не оставался в Яндекс ID
      if (tokens.refreshToken) {
        await this.revoke(tokens.accessToken)
      }
      return {
        ok: false,
        message:
          'Для использования бота требуется активная подписка Яндекс Плюс. Активируйте подписку и попробуйте снова.'
      }
    }

    const db = DatabaseService.getInstance()
    const wasAuthorized = db.hasUserToken(userId)
    db.saveUserToken(userId, tokens, userInfo)
    // Прежний токен того же аккаунта после входа может перестать работать, поэтому плееры пользователя переходят на новый
    PlayerService.getInstance().updateOwnerToken(userId, userInfo.id, tokens.accessToken)
    log.info(
      `Вход выполнен: пользователь ${userId}, аккаунт Яндекса ${userInfo.id}, ${tokens.refreshToken ? 'по коду' : 'по токену'}`
    )

    return { ok: true, name: escapeMarkdown(userInfo.nickName), wasAuthorized }
  }

  /**
   * Итог входа. Подтверждение исчезает само, а при ошибке остаются кнопки, чтобы попробовать снова.
   * Если вход начался с /my-wave, после него сразу запускается волна
   */
  private async complete(interaction: RepliableInteraction, goal: LoginGoal, outcome: LoginOutcome): Promise<void> {
    if (!outcome.ok) {
      await show(interaction, failedView(outcome.message, goal))
      return
    }

    if (goal === 'login') {
      const content = outcome.wasAuthorized
        ? `Готово! Теперь вы вошли как ${outcome.name}.`
        : `Готово! Вы вошли как ${outcome.name}. Запустить волну можно командой \`/my-wave\`.`
      await show(interaction, { content, components: [] }, LONG_NOTICE_TTL)
      return
    }

    await show(interaction, { content: `Готово! Вы вошли как ${outcome.name}. Запускаю волну…`, components: [] })
    const launch = await launchWave(interaction)
    if (launch.status === 'started') {
      // Подтверждение не нужно: в канале уже появился плеер
      await dismiss(interaction)
    } else if (launch.status === 'failed') {
      await show(interaction, {
        content: `Вы вошли как ${outcome.name}, но волну запустить не удалось.\n${launch.message}`,
        components: []
      })
    } else {
      await show(interaction, failedView('Яндекс Музыка не приняла вход. Попробуйте войти ещё раз.', goal))
    }
  }

  private async revoke(accessToken: string): Promise<void> {
    try {
      await this.oauth.revokeToken(accessToken)
    } catch (error) {
      log.warn('Не удалось отозвать токен Яндекса', error)
    }
  }

  /**
   * Прерывает вход по коду, который ждёт подтверждения. Если код показан не в текущем сообщении,
   * то сообщение с ним предупреждает, что код больше не действует
   */
  private cancel(userId: string, currentMessageId?: string): void {
    const pending = this.pending.get(userId)
    if (!pending) {
      return
    }

    this.pending.delete(userId)
    pending.abort.abort()
    if (pending.messageId && pending.messageId !== currentMessageId) {
      void show(pending.interaction, { content: STALE_NOTICE, components: [] })
    }
  }
}

/**
 * Токен из того, что вставил пользователь: сам токен или ссылка, где он записан после access_token=
 */
export function extractToken(input: string): string | null {
  const text = input.trim()
  const token = /(?:^|[#?&])access_token=([^&\s]+)/.exec(text)?.[1] ?? text
  return /^[\w.-]+$/.test(token) ? token : null
}

function codeView(code: DeviceCode, expiresAt: number, attempt: PendingLogin, current?: IUserData): LoginView {
  const site = code.verificationUrl.replace(/^https?:\/\//, '')
  const expires = time(new Date(expiresAt), TimestampStyles.RelativeTime)

  return {
    content: [
      codeIntro(attempt.goal, current),
      `1. Откройте ${site} там, где вы вошли в Яндекс: на телефоне или компьютере.`,
      `2. Введите код \`${code.userCode}\` и разрешите доступ.`,
      '',
      attempt.goal === 'wave'
        ? `Как только вы войдёте, я запущу волну. Код истекает ${expires}.`
        : `Я замечу вход сам. Код истекает ${expires}.`
    ].join('\n'),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel(`Открыть ${site}`).setURL(code.verificationUrl).setStyle(ButtonStyle.Link),
        manualButton(attempt.goal),
        new ButtonBuilder()
          .setCustomId(`${LOGIN_PREFIX}cancel:${attempt.id}`)
          .setLabel('Отмена')
          .setStyle(ButtonStyle.Secondary)
      )
    ]
  }
}

/**
 * Первая строка сообщения с кодом. Если вход начался с /my-wave, а пользователь уже входил, значит, Яндекс отклонил токен
 */
function codeIntro(goal: LoginGoal, current?: IUserData): string {
  if (goal === 'wave') {
    return current
      ? 'Вход в Яндекс Музыку истёк или был отозван. Войдите заново, и волна запустится:'
      : 'Чтобы запустить волну, войдите в Яндекс Музыку:'
  }
  return current
    ? `Вы уже вошли как ${escapeMarkdown(current.nickName)}. Если вход перестал работать или нужен другой аккаунт, войдите заново:`
    : 'Чтобы войти в Яндекс Музыку:'
}

/**
 * Неудачный вход: можно получить новый код или вставить токен
 */
function failedView(content: string, goal: LoginGoal): LoginView {
  return {
    content,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${LOGIN_PREFIX}retry:${goal}`)
          .setLabel('Получить новый код')
          .setStyle(ButtonStyle.Primary),
        manualButton(goal)
      )
    ]
  }
}

function manualButton(goal: LoginGoal): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${LOGIN_PREFIX}manual:${goal}`)
    .setLabel('Ввести токен вручную')
    .setStyle(ButtonStyle.Secondary)
}

function tokenModal(goal: LoginGoal): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${LOGIN_PREFIX}token:${goal}`)
    .setTitle('Вход по токену')
    .addTextDisplayComponents(text =>
      text.setContent(
        `Если вход по коду не подходит, получите токен Яндекс Музыки [одним из способов](${TOKEN_GUIDE_URL}) ` +
          'и вставьте его ниже. Подойдёт и вся ссылка, в которой есть `access_token=`.'
      )
    )
    .addLabelComponents(label =>
      label
        .setLabel('Токен')
        .setTextInputComponent(input =>
          input
            .setCustomId(TOKEN_INPUT_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('y0_AgAAAA…')
            .setMaxLength(1000)
        )
    )
}

/**
 * Обновляет сообщение со входом, а если передан ttl, удаляет его через ttl мс.
 * Не бросает исключений: пользователь мог уже закрыть сообщение
 */
async function show(interaction: RepliableInteraction, view: LoginView, ttl?: number): Promise<Message | undefined> {
  try {
    const message = await interaction.editReply(view)
    if (ttl) deleteLater(interaction, '@original', ttl)
    return message
  } catch (error) {
    log.warn('Не удалось обновить сообщение со входом', error)
    return undefined
  }
}
