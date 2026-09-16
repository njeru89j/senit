const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const points = {
  'Nairobi Central': [-1.2864, 36.8172], 'Westlands': [-1.2676, 36.8108],
  'Ruiru': [-1.1460, 36.9600], 'Thika': [-1.0396, 37.0900],
  'Athi River': [-1.4561, 36.9783], 'Machakos': [-1.5177, 37.2634],
  'Kiambu': [-1.1714, 36.8356], 'Limuru': [-1.1130, 36.6428],
  'Ngong': [-1.3610, 36.6566], 'Kajiado': [-1.8524, 36.7768],
  'Naivasha': [-0.7167, 36.4310], 'Nakuru': [-0.3031, 36.0800],
  'Junction Mall': [-1.3008, 36.7679], 'JKIA': [-1.3192, 36.9278],
  'Karen': [-1.3198, 36.7078], 'Kikuyu': [-1.2460, 36.6635],
};

const routes = [
  ['Nairobi–Thika Express', 'Nairobi Central', 'Thika', ['Nairobi Central', 'Ruiru', 'Thika']],
  ['Nairobi–Machakos Link', 'Nairobi Central', 'Machakos', ['Nairobi Central', 'JKIA', 'Athi River', 'Machakos']],
  ['Nairobi–Kiambu Line', 'Nairobi Central', 'Kiambu', ['Nairobi Central', 'Westlands', 'Kiambu']],
  ['Nairobi–Limuru Corridor', 'Nairobi Central', 'Limuru', ['Nairobi Central', 'Westlands', 'Kiambu', 'Limuru']],
  ['Nairobi–Ngong Route', 'Nairobi Central', 'Ngong', ['Nairobi Central', 'Junction Mall', 'Ngong']],
  ['Nairobi–Kajiado Route', 'Nairobi Central', 'Kajiado', ['Nairobi Central', 'Ngong', 'Kajiado']],
  ['Nairobi–Naivasha Highway', 'Nairobi Central', 'Naivasha', ['Nairobi Central', 'Westlands', 'Limuru', 'Naivasha']],
  ['Naivasha–Nakuru Link', 'Naivasha', 'Nakuru', ['Naivasha', 'Nakuru']],
  ['Karen–Machakos Connector', 'Karen', 'Machakos', ['Karen', 'Junction Mall', 'JKIA', 'Athi River', 'Machakos']],
  ['Kikuyu–Ruiru Cross Link', 'Kikuyu', 'Ruiru', ['Kikuyu', 'Westlands', 'Nairobi Central', 'Ruiru']],
];

async function main() {
  const records = {};
  for (const [name, [latitude, longitude]] of Object.entries(points)) {
    let point = await prisma.transitPoint.findFirst({ where: { name } });
    if (!point) point = await prisma.transitPoint.create({ data: { name, latitude, longitude, active: true } });
    else point = await prisma.transitPoint.update({ where: { id: point.id }, data: { latitude, longitude, active: true } });
    records[name] = point;
  }
  for (const [name, origin, destination, pointNames] of routes) {
    const route = await prisma.route.upsert({ where: { name }, create: { name, origin, destination, active: true }, update: { origin, destination, active: true } });
    await prisma.routeTransitPoint.deleteMany({ where: { routeId: route.id } });
    await prisma.routeTransitPoint.createMany({ data: pointNames.map((pointName, sequence) => ({ routeId: route.id, transitPointId: records[pointName].id, sequence: sequence + 1 })) });
  }
  console.log(JSON.stringify({ routes: await prisma.route.count(), transitPoints: await prisma.transitPoint.count(), routeLinks: await prisma.routeTransitPoint.count() }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
