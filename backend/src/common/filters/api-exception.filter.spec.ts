import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter';

describe('ApiExceptionFilter', () => {
  it('returns the standard error envelope for HTTP exceptions', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ method: 'POST', url: '/api/test' }),
      }),
    } as unknown as ArgumentsHost;

    new ApiExceptionFilter().catch(
      new BadRequestException({ message: 'Validation failed', errors: ['Email is required'] }),
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: 'Validation failed',
        details: ['Email is required'],
        path: '/api/test',
      }),
    );
  });
});
