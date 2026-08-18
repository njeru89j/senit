import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      this.logger.warn('No token provided in request');
      throw new UnauthorizedException('Access token is required');
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      
      // Additional validation
      if (!payload.sub || !payload.email || !payload.role) {
        this.logger.warn('Invalid token payload structure');
        throw new UnauthorizedException('Invalid token structure');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { email: true, role: true, isActive: true },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('Account is inactive or no longer exists');
      }

      // Use current database values so role changes and suspensions take
      // effect immediately instead of waiting for an old token to expire.
      payload.email = user.email;
      payload.role = user.role;

      request.user = payload;
      return true;
    } catch (error) {
      this.logger.error('Token verification failed:', error.message);
      
      if (error instanceof UnauthorizedException) {
        throw error;
      } else if (error.name === 'TokenExpiredError') {
        throw new UnauthorizedException('Token has expired');
      } else if (error.name === 'JsonWebTokenError') {
        throw new UnauthorizedException('Invalid token format');
      } else {
        throw new UnauthorizedException('Invalid or expired token');
      }
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
