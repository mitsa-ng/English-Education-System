import { Global, Module } from '@nestjs/common';
import { S3FileStorage } from './s3-file-storage';

export const FILE_STORAGE = Symbol('FILE_STORAGE');

@Global()
@Module({
  providers: [{ provide: FILE_STORAGE, useClass: S3FileStorage }],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
