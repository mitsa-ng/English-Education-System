import { randomInt } from 'node:crypto';

/** 邀請碼字元集：排除 0/O/1/I 等易混淆字元。 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const INVITE_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

/** 產生 XXXX-XXXX 格式邀請碼。碰撞由呼叫端以 unique 約束重試。 */
export function generateInviteCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `${group()}-${group()}`;
}

/** 學生預設密碼字元集：三段字母表組合（皆排除易混淆字元）。 */
const LOWERCASE = 'abcdefghijkmnpqrstuvwxyz';
const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const PASSWORD_CHARS = LOWERCASE + UPPERCASE + DIGITS;

export function generateInitialPassword(): string {
  return Array.from({ length: 10 }, () => PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)]).join('');
}

/** 學生預設 username 後綴（stu-xxxx）。 */
export function generateUsernameSuffix(): string {
  return String(randomInt(1000, 10000));
}
