/**
 * 檔案儲存邊界（keep external behind boundary）：
 * modules 只依賴此介面；實作（MinIO/S3）由 DI 注入。
 */
export interface PresignedUrl {
  url: string;
  expiresAt: Date;
}

export interface FileStorage {
  /** 確認 bucket 可用（啟動時呼叫；不可用僅警告，不阻斷啟動）。 */
  ensureBucket(): Promise<boolean>;
  /** 產生直接上傳 URL（PUT）。 */
  presignPut(key: string, expiresInSec: number): Promise<PresignedUrl>;
  /** 產生直接下載 URL（GET）。 */
  presignGet(key: string, expiresInSec: number): Promise<PresignedUrl>;
}
