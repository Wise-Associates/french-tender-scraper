import { BadRequestException, Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TendersService } from './tenders.service';

const MAX_LIMIT = 200;

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
  @ApiQuery({
    name: 'relevant',
    required: false,
    type: Boolean,
    description: 'true: only offers Claude matched to a category (with their analysis); false: all others',
  })
  find(
    @Query('site') site?: string,
    @Query('q') q?: string,
    @Query('since') since?: string,
    @Query('deadlineBefore') deadlineBefore?: string,
    // A string, checked below: the global ValidationPipe would turn any value but "true" into false.
    @Query('relevant') relevant?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    // Bounded: rows can carry long mission texts, and SQLite reads a negative LIMIT as "no limit".
    if (limit === undefined || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException(`limit must be between 1 and ${MAX_LIMIT}`);
    }
    if (offset === undefined || offset < 0) throw new BadRequestException('offset must be 0 or more');
    if (relevant !== undefined && relevant !== 'true' && relevant !== 'false') {
      throw new BadRequestException('relevant must be true or false');
    }
    const relevantFilter = relevant === undefined ? undefined : relevant === 'true';
    return this.tendersService.find({ site, q, since, deadlineBefore, relevant: relevantFilter, limit, offset });
  }

  @Get('stats')
  @ApiOperation({ summary: 'Totals per platform' })
  stats() {
    return this.tendersService.stats();
  }
}
