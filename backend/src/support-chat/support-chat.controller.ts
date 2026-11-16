import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { OptionalChatAuthGuard } from './optional-chat-auth.guard';
import { SupportChatService } from './support-chat.service';

@Controller('support-chat')
@UseGuards(OptionalChatAuthGuard)
export class SupportChatController {
  constructor(private readonly service: SupportChatService) {}

  @Post('message')
  message(@Request() request: { user?: { sub: string } }, @Body() body: { message?: string; trackingNumber?: string }) {
    return this.service.reply(request.user?.sub, body?.message ?? '', body?.trackingNumber);
  }
}
