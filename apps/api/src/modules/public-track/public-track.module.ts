import { Module } from '@nestjs/common';
import { PublicTrackController } from './public-track.controller';
import { PublicTrackService } from './public-track.service';

@Module({
  controllers: [PublicTrackController],
  providers: [PublicTrackService],
})
export class PublicTrackModule {}
