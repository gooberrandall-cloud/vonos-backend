import { Global, Module } from '@nestjs/common';
import { WhatsAppNotifyService } from './whatsapp-notify.service';

@Global()
@Module({
  providers: [WhatsAppNotifyService],
  exports: [WhatsAppNotifyService],
})
export class WhatsAppNotifyModule {}
