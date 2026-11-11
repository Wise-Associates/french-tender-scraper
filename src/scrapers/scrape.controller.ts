import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SITE_KEYS, SiteKey } from './tender.types';
import { ScrapingService } from './scraping.service';

class RunScrapeDto {
  @IsOptional()
  @IsArray()
  @IsIn(SITE_KEYS, { each: true })
  sites?: SiteKey[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxResults?: number;
}

@ApiTags('scrape')
@Controller('scrape')
export class ScrapeController {
  constructor(private readonly scraping: ScrapingService) {}

  @Get('scrapers')
  @ApiOperation({ summary: 'List available scrapers and their enabled state' })
  listScrapers() {
    return this.scraping.listScrapers();
  }

  @Post('run')
  @ApiOperation({ summary: 'Run scrapers on demand (body: { sites?, keywords?, maxResults? })' })
  run(@Body() dto: RunScrapeDto) {
    return this.scraping.run(dto.sites, { keywords: dto.keywords, maxResults: dto.maxResults });
  }

  @Get('last-runs')
  @ApiOperation({ summary: 'Results of the last scraping runs' })
  lastRuns() {
    return this.scraping.getLastResults();
  }
}
