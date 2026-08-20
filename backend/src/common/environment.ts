const PLACEHOLDER_VALUES = [
  '',
  'your-email@gmail.com',
  'your-email-password',
  'your-app-password',
  'replace-with-a-long-random-secret',
  'replace-with-a-different-long-random-secret',
];

export function isPlaceholder(value: string | undefined): boolean {
  return !value || PLACEHOLDER_VALUES.includes(value.trim());
}

export function isEmailEnabled(): boolean {
  if (process.env.MAIL_ENABLED?.toLowerCase() === 'false') return false;
  return !isPlaceholder(process.env.MAIL_USER) && !isPlaceholder(process.env.MAIL_PASSWORD);
}

export function validateEnvironment(): void {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = process.env.NODE_ENV === 'production';

  if (isPlaceholder(process.env.DATABASE_URL)) errors.push('DATABASE_URL must be configured');
  if (isPlaceholder(process.env.JWT_SECRET)) {
    errors.push('JWT_SECRET must be configured with a non-placeholder value');
  } else if ((process.env.JWT_SECRET?.length ?? 0) < 32) {
    (production ? errors : warnings).push('JWT_SECRET should contain at least 32 characters');
  }
  if (isPlaceholder(process.env.JWT_REFRESH_SECRET)) {
    errors.push('JWT_REFRESH_SECRET must be configured with a non-placeholder value');
  } else if ((process.env.JWT_REFRESH_SECRET?.length ?? 0) < 32) {
    (production ? errors : warnings).push('JWT_REFRESH_SECRET should contain at least 32 characters');
  }

  if (errors.length > 0) throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  warnings.forEach((warning) => console.warn(`Environment warning: ${warning}`));
}
