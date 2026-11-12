import { Module } from '@nestjs/common';
import { TendersModule } from '../tenders/tenders.module';
import { ClaudeAnalyzer } from './claude-analyzer.service';
import { OfferAnalysisService } from './offer-analysis.service';

@Module({
  imports: [TendersModule],
  providers: [ClaudeAnalyzer, OfferAnalysisService],
  exports: [OfferAnalysisService],
})
export class AnalysisModule {}
