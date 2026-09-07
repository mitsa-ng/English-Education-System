import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FileStorage, PresignedUrl } from './file-storage.interface';

/**
 * MinIO（S3 相容）實作。presign 是本地計算（sigv4），不需服務在線；
 * ensureBucket 才需要 MinIO 可達，失敗只警告——測試環境沒有 MinIO 也能跑。
 */
@Injectable()
export class S3FileStorage implements FileStorage, OnModuleInit {
  private readonly logger = new Logger(S3FileStorage.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>('MINIO_BUCKET') ?? 'ees-attachments';
    this.client = new S3Client({
      endpoint: config.get<string>('MINIO_ENDPOINT') ?? 'http://localhost:9000',
      region: config.get<string>('MINIO_REGION') ?? 'us-east-1',
      credentials: {
        accessKeyId: config.get<string>('MINIO_ACCESS_KEY') ?? 'minioadmin',
        secretAccessKey: config.get<string>('MINIO_SECRET_KEY') ?? 'minioadmin',
      },
      forcePathStyle: true, // MinIO 必需
    });
  }

  async onModuleInit(): Promise<void> {
    const ok = await this.ensureBucket();
    if (!ok) {
      this.logger.warn('MinIO 不可達：上傳/下載 URL 仍可簽發，但實際 PUT/GET 會失敗');
    }
  }

  async ensureBucket(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        return true;
      } catch (error) {
        this.logger.error(`bucket 初始化失敗：${String(error)}`);
        return false;
      }
    }
  }

  async presignPut(key: string, expiresInSec: number): Promise<PresignedUrl> {
    const url = await awsGetSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSec },
    );
    return { url, expiresAt: new Date(Date.now() + expiresInSec * 1000) };
  }

  async presignGet(key: string, expiresInSec: number): Promise<PresignedUrl> {
    const url = await awsGetSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSec },
    );
    return { url, expiresAt: new Date(Date.now() + expiresInSec * 1000) };
  }
}
