import { Module } from '@nestjs/common';
import { TendersModule } from '../tenders/tenders.module';
import { MbcStatusReporter } from './mbc-status';
import { AlertMailer, OperatorAlertsService } from './operator-alerts.service';

@Module({
  imports: [TendersModule],
  providers: [AlertMailer, OperatorAlertsService, MbcStatusReporter],
  exports: [OperatorAlertsService, MbcStatusReporter],
})
export class AlertsModule {}
