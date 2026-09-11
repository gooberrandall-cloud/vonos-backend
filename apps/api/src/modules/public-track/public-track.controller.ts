import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { PublicTrackService } from './public-track.service';

/** Public vehicle tracker — VA + VP only, no JWT, no financials. */
@Controller('public/track')
export class PublicTrackController {
  constructor(private readonly track: PublicTrackService) {}

  @Get()
  lookup(
    @Query('name') name?: string,
    @Query('registration') registration?: string,
    @Query('reg') reg?: string,
  ) {
    const customerName = name?.trim() ?? '';
    const plate = (registration ?? reg)?.trim() ?? '';
    if (!customerName || !plate) {
      throw new BadRequestException(
        'name and registration (plate) are required',
      );
    }
    return this.track.lookup({ name: customerName, registration: plate });
  }

  /**
   * Customer opts in: save WhatsApp number against the matched vehicle plate.
   * That number is used for status WhatsApp notifies.
   */
  @Post('subscribe')
  subscribe(
    @Body()
    body: {
      name?: string;
      registration?: string;
      reg?: string;
      whatsapp?: string;
    },
  ) {
    const customerName = body.name?.trim() ?? '';
    const plate = (body.registration ?? body.reg)?.trim() ?? '';
    const whatsapp = body.whatsapp?.trim() ?? '';
    if (!customerName || !plate || !whatsapp) {
      throw new BadRequestException(
        'name, registration (plate), and whatsapp are required',
      );
    }
    return this.track.subscribeWhatsApp({
      name: customerName,
      registration: plate,
      whatsapp,
    });
  }
}
