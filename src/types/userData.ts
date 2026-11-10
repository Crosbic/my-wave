export interface IUserData {
  id: string
  fullName: string
  firstName: string
  lastName: string
  nickName: string
  avatarUrl: string
  hasPlus: boolean
}

/**
 * Токены Яндекса. refreshToken и expiresAt есть только у токенов, которые бот получил сам, входом по коду:
 * такие токены бот продлевает и отзывает. Токен, вставленный вручную, мог пригодиться и в других приложениях,
 * поэтому его бот только хранит
 */
export interface YandexTokens {
  accessToken: string
  refreshToken?: string
  // Когда истекает accessToken, мс с начала эпохи
  expiresAt?: number
}

/**
 * Что бот хранит о входе пользователя Discord в Яндекс Музыку
 */
export interface StoredUser extends YandexTokens {
  userInfo: IUserData
}
