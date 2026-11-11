import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TendersModule } from './tenders/tenders.module';
import { ScrapersModule } from './scrapers/scrapers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    ScheduleModule.forRoot(),
    TendersModule,
    ScrapersModule,
  ],
})
export class AppModule {}
