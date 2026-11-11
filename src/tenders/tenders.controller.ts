import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TendersService } from './tenders.service';

@ApiTags('tenders')
@Controller('tenders')
export class TendersController {
  constructor(private readonly tendersService: TendersService) {}

  @Get()
  @ApiOperation({ summary: 'Search stored tenders' })
  @ApiQuery({ name: 'site', required: false })
  @ApiQuery({ name: 'q', required: false, description: 'Keyword search in title/buyer/description' })
  @ApiQuery({ name: 'since', required: false, description: 'ISO date — only tenders first seen after this date' })
  @ApiQuery({ name: 'deadlineBefore', required: false, description: 'ISO date — deadlines before this date' })
  find(
    @Query('site') site?: string,
    @Query('q') q?: string,
    @Query('since') since?: string,
    @Query('deadlineBefore') deadlineBefore?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.tendersService.find({ site, q, since, deadlineBefore, limit, offset });
  }

  @Get('stats')
  @ApiOperation({ summary: 'Totals per platform' })
  stats() {
    return this.tendersService.stats();
  }
}
