const { PrismaClient, UserRole } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const drivers = await prisma.user.findMany({ where: { role: UserRole.DRIVER }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
  await prisma.$transaction(async tx => {
    for (let index = 0; index < drivers.length; index++) {
      await tx.user.update({ where: { id: drivers[index].id }, data: { email: `driver-${index + 1}@gmail.com` } });
    }
  });
  console.log(JSON.stringify({ drivers: drivers.length, firstEmail: drivers.length ? 'driver-1@gmail.com' : null }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
