const { PrismaClient, LockerSize } = require('@prisma/client');

const prisma = new PrismaClient();
const sizes = [
  ...Array(8).fill(LockerSize.SMALL),
  ...Array(7).fill(LockerSize.MEDIUM),
  ...Array(6).fill(LockerSize.LARGE),
  ...Array(4).fill(LockerSize.EXTRA_LARGE),
];

async function main() {
  const points = await prisma.transitPoint.findMany({ where: { active: true } });
  let created = 0;

  for (const point of points) {
    const station = await prisma.lockerStation.upsert({
      where: { name: `${point.name} Smart Lockers` },
      update: {
        address: point.name,
        transitPointId: point.id,
        latitude: point.latitude,
        longitude: point.longitude,
        active: true,
      },
      create: {
        name: `${point.name} Smart Lockers`,
        address: point.name,
        transitPointId: point.id,
        latitude: point.latitude,
        longitude: point.longitude,
        active: true,
      },
    });

    const existing = await prisma.lockerCompartment.findMany({
      where: { stationId: station.id },
      select: { compartmentNo: true },
    });
    const existingNumbers = new Set(existing.map((locker) => locker.compartmentNo));
    const missing = sizes
      .map((size, index) => ({ compartmentNo: `L-${String(index + 1).padStart(2, '0')}`, size }))
      .filter((locker) => !existingNumbers.has(locker.compartmentNo));

    if (missing.length) {
      await prisma.lockerCompartment.createMany({
        data: missing.map((locker) => ({ ...locker, stationId: station.id })),
      });
      created += missing.length;
    }
  }

  console.log(JSON.stringify({ transitPoints: points.length, lockersCreated: created, lockersPerPoint: 25 }));
}

main().finally(() => prisma.$disconnect());
