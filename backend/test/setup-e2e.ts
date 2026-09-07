/**
 * e2e 測試環境變數：在 AppModule import（ConfigModule 驗證 env）之前設好。
 * 僅補預設值，不覆蓋 CI 已提供的變數（如 DATABASE_URL）。
 */
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:testpassword@localhost:5433/ees_test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? 'e2e-test-secret-0123456789abcdef0123456789abcdef';
process.env.SERVER_NAME = 'e2e 測試站';
