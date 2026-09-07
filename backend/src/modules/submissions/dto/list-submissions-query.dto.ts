import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PageQuery } from '../../../common/types/pagination';

export class ListSubmissionsQueryDto extends PageQuery {
  @ApiPropertyOptional({ enum: ['PENDING', 'SUBMITTED', 'GRADED', 'RETURNED'] })
  @IsOptional()
  @IsIn(['PENDING', 'SUBMITTED', 'GRADED', 'RETURNED'])
  status?: 'PENDING' | 'SUBMITTED' | 'GRADED' | 'RETURNED';
}
