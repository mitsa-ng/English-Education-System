import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PageQuery } from '../../../common/types/pagination';

export class ListAssignmentsQueryDto extends PageQuery {
  @ApiPropertyOptional({ enum: ['DRAFT', 'PUBLISHED', 'CLOSED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'PUBLISHED', 'CLOSED'])
  status?: 'DRAFT' | 'PUBLISHED' | 'CLOSED';

  @ApiPropertyOptional({ enum: ['ESSAY', 'GENERAL'] })
  @IsOptional()
  @IsIn(['ESSAY', 'GENERAL'])
  type?: 'ESSAY' | 'GENERAL';
}
