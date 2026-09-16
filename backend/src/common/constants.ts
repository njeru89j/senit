// Delivery Fee Constants
export const DELIVERY_FEE_CONFIG = {
  MINIMUM_FEE: 300, // KSH 300 for parcels below 5 kg and KSH 5,000 declared value
  LIGHT_WEIGHT_LIMIT_KG: 5,
  LOW_DECLARED_VALUE_LIMIT: 5000,
  BASE_PER_KG_FEE: 20,
  DISTANCE_BAND_KM: 100,
  DISTANCE_BAND_PER_KG_INCREASE: 5,
} as const;

// Parcel Status Constants
export const PARCEL_STATUS = {
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  PICKED_UP: 'picked_up',
  IN_TRANSIT: 'in_transit',
  DELIVERED_TO_RECIPIENT: 'delivered_to_recipient',
  DELIVERED: 'delivered',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const;

// User Role Constants
export const USER_ROLE = {
  CUSTOMER: 'CUSTOMER',
  DRIVER: 'DRIVER',
  ADMIN: 'ADMIN',
} as const;

// Vehicle Type Constants
export const VEHICLE_TYPE = {
  MOTORCYCLE: 'MOTORCYCLE',
  CAR: 'CAR',
  VAN: 'VAN',
  TRUCK: 'TRUCK',
} as const;

// JWT Configuration
export const JWT_CONFIG = {
  secret: process.env.JWT_SECRET || 'sendit-super-secret-jwt-key-2024-secure-and-unique',
  refreshSecret: process.env.JWT_REFRESH_SECRET || 'sendit-refresh-secret-key-2024-secure-and-unique',
  accessTokenExpiresIn: '1h' as const,
  refreshTokenExpiresIn: '7d' as const,
  signOptions: {
    issuer: 'sendit-api' as const,
    audience: 'sendit-client' as const,
  },
  verifyOptions: {
    issuer: 'sendit-api' as const,
    audience: 'sendit-client' as const,
  },
} as const;

// Type-safe JWT configuration
export type JwtConfigType = typeof JWT_CONFIG;
