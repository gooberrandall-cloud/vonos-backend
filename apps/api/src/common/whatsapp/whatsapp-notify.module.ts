import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../../modules/auth/auth.module';
import { BaileysWhatsAppService } from './baileys-whatsapp.service';
import { WhatsAppNotifyService } from './whatsapp-notify.service';
import { WhatsAppController } from './whatsapp.controller';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [WhatsAppController],
  providers: [BaileysWhatsAppService, WhatsAppNotifyService],
  exports: [BaileysWhatsAppService, WhatsAppNotifyService],
})
export class WhatsAppNotifyModule {}
