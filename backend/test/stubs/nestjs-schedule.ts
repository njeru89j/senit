/**
 * Jest stand-in for @nestjs/schedule, whose v12 build is ESM-only and cannot be loaded by ts-jest.
 * Tests call the scheduled sweeps directly, so the decorators only need to be inert.
 */
export const Cron = (): MethodDecorator => () => undefined;
export const Interval = (): MethodDecorator => () => undefined;
export const Timeout = (): MethodDecorator => () => undefined;
export enum CronExpression {
  EVERY_MINUTE = '0 * * * * *',
  EVERY_10_MINUTES = '0 */10 * * * *',
}
export class ScheduleModule {
  static forRoot() {
    return { module: ScheduleModule };
  }
}
