import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { validateEnvironment } from './common/environment';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  try {
    validateEnvironment();
    const app = await NestFactory.create(AppModule, {
      logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    });

    app.useGlobalFilters(new ApiExceptionFilter());

    // Enable CORS
    const configuredFrontend = process.env.FRONTEND_URL;
    const allowedOrigins = new Set([
      'http://localhost:4200',
      'http://127.0.0.1:4200',
      ...(configuredFrontend ? [configuredFrontend] : []),
    ]);
    const isLocalDevelopmentOrigin = (origin: string) =>
      /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin);

    app.enableCors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.has(origin) || isLocalDevelopmentOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['*'],
    });

    // Global validation pipe
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    // API prefix
    app.setGlobalPrefix('api');

    const port = process.env.PORT ?? 3000;
    await app.listen(port);

    logger.log(`Application is running on: http://localhost:${port}`);
  } catch (error) {
    logger.error(
      'Failed to start application',
      error instanceof Error ? error.stack : error,
    );
    process.exit(1);
  }
}

void bootstrap();
