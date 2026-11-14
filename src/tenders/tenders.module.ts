import { Module } from '@nestjs/common';
import { TendersRepository } from './tenders.repository';
import { TendersService } from './tenders.service';
import { TendersController } from './tenders.controller';

@Module({
  controllers: [TendersController],
  providers: [TendersRepository, TendersService],
  exports: [TendersService, TendersRepository],
})
export class TendersModule {}
