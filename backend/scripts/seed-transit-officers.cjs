const { PrismaClient, UserRole } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();
const TEMPORARY_PASSWORD = 'SendIT@2026';

function emailFor(name) {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}@sendit.com`;
}

async function main() {
  const points = await prisma.transitPoint.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
  const pointNames = new Set(points.map(point => point.name));
  const routes = await prisma.route.findMany({ where: { active: true } });
  const invalidRoutes = routes.filter(route => !pointNames.has(route.origin) || !pointNames.has(route.destination));
  if (invalidRoutes.length) throw new Error(`Route origins/destinations must be transit points: ${invalidRoutes.map(route => route.name).join(', ')}`);

  const password = await bcrypt.hash(TEMPORARY_PASSWORD, 12);
  const phoneNumbers = new Set();
  const randomPhone = () => {
    let phone;
    do phone = `07${Math.floor(10000000 + Math.random() * 90000000)}`; while (phoneNumbers.has(phone));
    phoneNumbers.add(phone);
    return phone;
  };
  await prisma.$transaction(async (tx) => {
    await tx.transitPointOfficer.deleteMany();
    for (const point of points) {
      const email = emailFor(point.name);
      const officer = await tx.user.upsert({
        where: { email },
        create: { name: point.name, email, phone: randomPhone(), password, role: UserRole.TRANSIT_OFFICER, isActive: true },
        update: { name: point.name, phone: randomPhone(), role: UserRole.TRANSIT_OFFICER, isActive: true },
      });
      await tx.transitPointOfficer.create({ data: { transitPointId: point.id, officerId: officer.id } });
      await tx.transitPoint.update({ where: { id: point.id }, data: { officerId: officer.id } });
    }
  });
  console.log(JSON.stringify({ transitPoints: points.length, officers: await prisma.user.count({ where: { role: UserRole.TRANSIT_OFFICER } }), routesValidated: routes.length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
