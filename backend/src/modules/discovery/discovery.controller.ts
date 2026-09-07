import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Discovery')
@Controller()
export class DiscoveryController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get('discovery')
  @ApiOperation({ summary: '伺服器自我介紹（公開，學生端驗證站點用）' })
  discovery() {
    return {
      serverName: this.config.get<string>('SERVER_NAME') ?? '',
      teacherName: this.config.get<string>('TEACHER_NAME') ?? '',
      school: this.config.get<string>('SCHOOL') ?? '',
      apiVersion: 'v1',
      softwareVersion: this.config.get<string>('SOFTWARE_VERSION') ?? '0.1.0',
      description: this.config.get<string>('SERVER_DESCRIPTION') ?? '',
      features: ['essay-analysis'],
    };
  }

  @Public()
  @Get('health')
  @ApiOperation({ summary: '健康檢查（公開）' })
  health() {
    return { status: 'ok', version: this.config.get<string>('SOFTWARE_VERSION') ?? '0.1.0' };
  }
}
