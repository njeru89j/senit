import { HttpErrorResponse } from '@angular/common/http';
import { getApiErrorMessage } from './api-error';

describe('getApiErrorMessage', () => {
  it('returns the validation details from the API response', () => {
    const error = new HttpErrorResponse({
      status: 400,
      error: {
        message: 'Validation failed',
        details: ['Phone number must contain exactly 10 digits'],
      },
    });

    expect(getApiErrorMessage(error)).toBe(
      'Phone number must contain exactly 10 digits',
    );
  });
});
