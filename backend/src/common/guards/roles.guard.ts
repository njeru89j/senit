import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user;

    if (!user) {
      return false;
    }

    // Admins hold every transit-officer capability across all stations; the
    // services apply station scoping only to officers.
    if (user.role === 'ADMIN' && requiredRoles.includes('TRANSIT_OFFICER')) return true;

    return requiredRoles.some((role) => user.role === role);
  }
}
