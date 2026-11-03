import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Injectable()
export class OptionalChatAuthGuard implements CanActivate {
  constructor(private readonly auth: JwtAuthGuard) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    // Guests are welcome; a supplied credential must still pass normal validation.
    if (!request.headers.authorization) return true;
    return this.auth.canActivate(context);
  }
}
