import { z } from 'zod';

/**
 * 環境變數 schema：啟動時驗證，缺漏或格式錯誤直接拒絕啟動
 * （condition check upfront——不讓帶著壞設定上線）。
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 需至少 32 字元'),
  JWT_ACCESS_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // discovery 資訊
  SERVER_NAME: z.string().default('我的英語教室'),
  TEACHER_NAME: z.string().default(''),
  SCHOOL: z.string().default(''),
  SERVER_DESCRIPTION: z.string().default(''),
  SOFTWARE_VERSION: z.string().default('0.1.0'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`環境變數驗證失敗：\n${issues}`);
  }
  return parsed.data;
}
