import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommonModule } from '../common/common.module';
import { SupportChatController } from './support-chat.controller';
import { SupportChatService } from './support-chat.service';
import { OptionalChatAuthGuard } from './optional-chat-auth.guard';

@Module({
  imports: [AuthModule, CommonModule],
  controllers: [SupportChatController],
  providers: [SupportChatService, OptionalChatAuthGuard],
})
export class SupportChatModule {}
