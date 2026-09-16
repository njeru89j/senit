/* Creates one smart-locker station with 25 mixed-size compartments per active transit point. */
require('dotenv').config();
const { PrismaClient, LockerSize, LockerStatus } = require('@prisma/client');
const prisma = new PrismaClient();

const layout = [
  ...Array.from({ length: 8 }, () => LockerSize.SMALL),
  ...Array.from({ length: 8 }, () => LockerSize.MEDIUM),
  ...Array.from({ length: 6 }, () => LockerSize.LARGE),
  ...Array.from({ length: 3 }, () => LockerSize.EXTRA_LARGE),
];

async function main() {
  const points = await prisma.transitPoint.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
  let compartmentsCreated = 0;
  for (const point of points) {
    const station = await prisma.lockerStation.upsert({
      where: { name: `${point.name} Smart Lockers` },
      update: { address: `${point.name} Transit Point`, transitPointId: point.id, latitude: point.latitude, longitude: point.longitude, active: true },
      create: { name: `${point.name} Smart Lockers`, address: `${point.name} Transit Point`, transitPointId: point.id, latitude: point.latitude, longitude: point.longitude, openingHours: '24 hours', active: true },
    });
    for (const [index, size] of layout.entries()) {
      const compartmentNo = `SL-${String(index + 1).padStart(2, '0')}`;
      await prisma.lockerCompartment.upsert({
        where: { stationId_compartmentNo: { stationId: station.id, compartmentNo } },
        update: { size, status: LockerStatus.AVAILABLE },
        create: { stationId: station.id, compartmentNo, size, status: LockerStatus.AVAILABLE },
      });
      compartmentsCreated += 1;
    }
  }
  console.log(JSON.stringify({ transitPoints: points.length, stations: points.length, compartmentsEnsured: compartmentsCreated, perStation: layout.length, sizes: { SMALL: 8, MEDIUM: 8, LARGE: 6, EXTRA_LARGE: 3 } }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
