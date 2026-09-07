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
  /** 直接讀取物件（sidecar 分析輸入用）。 */
  getObject(key: string): Promise<Uint8Array>;
  /** 直接寫入物件（標註 PDF 回存用）。 */
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
}
