import { Module } from '@nestjs/common';
import { TendersModule } from '../tenders/tenders.module';
import { AlertMailer, OperatorAlertsService } from './operator-alerts.service';

@Module({
  imports: [TendersModule],
  providers: [AlertMailer, OperatorAlertsService],
  exports: [OperatorAlertsService],
})
export class AlertsModule {}
