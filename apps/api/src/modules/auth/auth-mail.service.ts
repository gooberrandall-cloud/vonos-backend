import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AuthMailService {
  private readonly logger = new Logger(AuthMailService.name);

  sendPasswordReset(email: string, resetUrl: string): void {
    this.logger.log(`Password reset for ${email}: ${resetUrl}`);
  }

  sendInvite(email: string, inviteUrl: string): void {
    this.logger.log(`Invite for ${email}: ${inviteUrl}`);
  }
}
