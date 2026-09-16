const { PrismaClient, UserRole, VehicleType } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();
const TEMPORARY_PASSWORD = 'SendIT@2026';

function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function km(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLng = rad(b.longitude - a.longitude);
  const n = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(n), Math.sqrt(1 - n));
}

async function main() {
  const routes = await prisma.route.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
  const points = await prisma.transitPoint.findMany({ where: { active: true } });
  const byName = new Map(points.map(point => [point.name, point]));
  const password = await bcrypt.hash(TEMPORARY_PASSWORD, 12);
  let createdOrUpdated = 0;
  for (const route of routes) {
    const distance = km(byName.get(route.origin), byName.get(route.destination));
    const vehicles = distance >= 55 ? [VehicleType.TRUCK, VehicleType.TRUCK, VehicleType.VAN] : [VehicleType.MOTORCYCLE, VehicleType.CAR, VehicleType.VAN];
    for (let index = 0; index < vehicles.length; index++) {
      const number = index + 1, email = `${slug(route.name)}-driver-${number}@sendit.com`;
      const driver = await prisma.user.upsert({
        where: { email },
        create: { name: `${route.name} Driver ${number}`, email, phone: `07${String(10000000 + createdOrUpdated).padStart(8, '0')}`, password, role: UserRole.DRIVER, vehicleType: vehicles[index], vehicleNumber: `KSD ${route.name.replace(/[^A-Z]/gi, '').slice(0, 3).toUpperCase()} ${number}`, driverApplicationStatus: 'APPROVED', driverApprovalDate: new Date(), isActive: true, isAvailable: true },
        update: { role: UserRole.DRIVER, vehicleType: vehicles[index], driverApplicationStatus: 'APPROVED', isActive: true, isAvailable: true },
      });
      await prisma.driverProfile.upsert({ where: { userId: driver.id }, create: { userId: driver.id, routesServed: [route.id], currentRouteId: route.id, approvalStatus: 'APPROVED' }, update: { routesServed: [route.id], currentRouteId: route.id, approvalStatus: 'APPROVED' } });
      createdOrUpdated++;
    }
  }
  console.log(JSON.stringify({ routes: routes.length, driversSeeded: createdOrUpdated }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
