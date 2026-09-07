/**
 * Branded types：讓 ID 在編譯期不可互換（make invalid state harder to represent）。
 * Prisma 回傳的是純 string，透過 common/types/from-prisma.ts 的鑄造函式集中轉換。
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, 'UserId'>;
export type ClassId = Brand<string, 'ClassId'>;
export type StudentId = Brand<string, 'StudentId'>;
export type AssignmentId = Brand<string, 'AssignmentId'>;
export type SubmissionId = Brand<string, 'SubmissionId'>;
export type AnalysisResultId = Brand<string, 'AnalysisResultId'>;

export const asUserId = (value: string): UserId => value as UserId;
export const asClassId = (value: string): ClassId => value as ClassId;
