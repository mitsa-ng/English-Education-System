import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PageQuery } from '../../../common/types/pagination';

export class ListClassStudentsQueryDto extends PageQuery {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'REMOVED'], default: 'ACTIVE' })
  @IsOptional()
  @IsIn(['ACTIVE', 'REMOVED'])
  status?: 'ACTIVE' | 'REMOVED';
}
