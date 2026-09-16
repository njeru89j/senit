import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { DriversController } from '../drivers/drivers.controller';
import { DriversService } from '../drivers/drivers.service';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

describe('Admin driver upgrades', () => {
  let app: INestApplication;
  const upgrade = jest.fn().mockResolvedValue({ id: 'customer-1', role: 'DRIVER' });
  const details = { licenseNumber: 'LICENSE123', vehicleType: 'CAR' };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminController, DriversController],
      providers: [
        { provide: AdminService, useValue: { upgradeCustomerToDriver: upgrade } },
        { provide: DriversService, useValue: {} },
        { provide: PrismaService, useValue: {} },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({
      canActivate(context: any) {
        const req = context.switchToHttp().getRequest();
        req.user = { id: 'actor-1', role: req.headers['x-test-role'] };
        return true;
      },
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => upgrade.mockClear());

  it.each(['CUSTOMER', 'DRIVER', 'TRANSIT_OFFICER'])('denies upgrades by %s', async (role) => {
    await request(app.getHttpServer()).patch('/admin/users/customer-1/upgrade-to-driver').set('x-test-role', role).send(details).expect(403);
    expect(upgrade).not.toHaveBeenCalled();
  });
  it('allows an admin to upgrade a customer without an application', async () => {
    await request(app.getHttpServer()).patch('/admin/users/customer-1/upgrade-to-driver').set('x-test-role', 'ADMIN').send(details).expect(200);
    expect(upgrade).toHaveBeenCalledWith('customer-1', details, 'actor-1');
  });
  it('rejects invalid driver details', async () => {
    await request(app.getHttpServer()).patch('/admin/users/customer-1/upgrade-to-driver').set('x-test-role', 'ADMIN').send({ licenseNumber: ' ', vehicleType: 'BOAT' }).expect(400);
    expect(upgrade).not.toHaveBeenCalled();
  });
  it('removes the customer application endpoint', async () => {
    await request(app.getHttpServer()).post('/drivers/apply').set('x-test-role', 'CUSTOMER').send(details).expect(404);
  });
});
