import { Module } from '@nestjs/common';
import { TendersModule } from '../tenders/tenders.module';
import { ClaudeAnalyzer } from './claude-analyzer.service';
import { OfferAnalysisService } from './offer-analysis.service';
import { OpenAiAnalyzer } from './openai-analyzer.service';

@Module({
  imports: [TendersModule],
  providers: [ClaudeAnalyzer, OpenAiAnalyzer, OfferAnalysisService],
  exports: [OfferAnalysisService],
})
export class AnalysisModule {}
