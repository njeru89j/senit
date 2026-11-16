import { registerSchema } from './auth.schemas';

describe('registerSchema', () => {
  const validRegistration = {
    email: 'customer@example.com',
    password: 'SecurePass123!',
    name: 'Test Customer',
    phone: '0700000000',
  };

  it('accepts a standard customer registration', () => {
    const result = registerSchema.validate(validRegistration);

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(validRegistration);
  });

  it('requires a phone number containing exactly 10 digits', () => {
    expect(registerSchema.validate({ ...validRegistration, phone: undefined }).error).toBeDefined();
    expect(registerSchema.validate({ ...validRegistration, phone: '070000000' }).error).toBeDefined();
    expect(registerSchema.validate({ ...validRegistration, phone: '07000-00000' }).error).toBeDefined();
  });

  it('discards role and route fields from legacy public registration requests', () => {
    const result = registerSchema.validate({
      ...validRegistration,
      role: 'ADMIN',
      routesServed: ['privileged-route'],
      currentRouteId: 'privileged-route',
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(validRegistration);
  });

  it('rejects driver credentials in public registration', () => {
    const result = registerSchema.validate({
      ...validRegistration,
      licenseNumber: 'DL-12345',
    });

    expect(result.error).toBeDefined();
    expect(result.error?.details[0].type).toBe('object.unknown');
  });
});
