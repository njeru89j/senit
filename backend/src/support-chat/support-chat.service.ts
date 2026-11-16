import { BadRequestException, Injectable } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../database/prisma.service';
import { SUPPORT_KNOWLEDGE, SUPPORT_SOURCE } from './support-knowledge';

@Injectable()
export class SupportChatService {
  constructor(private readonly prisma: PrismaService) {}

  async reply(userId: string | undefined, rawMessage: string, contextTrackingNumber?: string) {
    if (typeof rawMessage !== 'string' || rawMessage.length > 2000) throw new BadRequestException('Enter a question of up to 2000 characters.');
    if (contextTrackingNumber !== undefined && (typeof contextTrackingNumber !== 'string' || !/^(?:SENDIT|SIT)[A-Z0-9-]{4,60}$/i.test(contextTrackingNumber))) throw new BadRequestException('Invalid tracking ID.');
    const message = rawMessage.trim();
    if (!message) throw new BadRequestException('Please enter a question.');

    const lower = message.toLowerCase();
    const explicitTracking = message.match(/\b(?:SENDIT|SIT)[A-Z0-9-]{4,60}\b/i)?.[0];
    const trackingIntent = /\b(my (?:parcel|delivery|shipment|locker)|latest|history|updates?|status|where is my|where's my|track (?:my|parcel|it)|recent parcels)\b/i.test(message);
    const trackingNumber = explicitTracking || (trackingIntent ? contextTrackingNumber : undefined);
    if (trackingNumber) return this.publicTracking(trackingNumber);
    if (trackingIntent && !userId) {
      return { reply: 'Paste your tracking ID here to see the latest parcel status, or sign in to view parcels you sent or are receiving.', requiresTracking: true, suggestions: ['How does tracking work?', 'How does locker collection work?'] };
    }
    if (!trackingIntent && /\b(show|list|active|available)\b/i.test(message) && /transit points|stations/i.test(message)) {
      const points = await this.prisma.transitPoint.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: 'asc' } });
      return { reply: points.length ? `Active SendIT transit points: ${points.map((point) => point.name).join(', ')}.` : 'No active transit points are currently configured.' };
    }
    if (this.isDeliveryAreaQuestion(lower)) {
      const transitPoints = await this.prisma.transitPoint.findMany({
        where: { active: true },
        select: { id: true, name: true, contact: true, latitude: true, longitude: true },
        orderBy: { name: 'asc' },
      });
      const matched = transitPoints.filter((point) => this.matchesTransitPoint(lower, point.name));
      const area = this.areaFromQuestion(message);
      if (matched.length) {
        const stations = await this.prisma.lockerStation.findMany({
          where: { transitPointId: { in: matched.map((point) => point.id) }, active: true },
          select: { transitPointId: true, address: true },
        });
        const closest = matched[0];
        const address = stations.find((station) => station.transitPointId === closest.id)?.address;
        const addressText = address ? ` Its collection address is ${address}.` : ' Its exact building address has not yet been recorded in SendIT.';
        return { reply: `Yes, we currently serve ${area || 'that area'}. The nearest matching active transit point is ${closest.name}.${addressText} You can create a delivery request and choose the available collection or delivery option.`, suggestions: ['How does locker collection work?', 'Track my parcel'] };
      }
      const coordinates = await this.geocode(area || message);
      if (coordinates && transitPoints.length) {
        const nearest = transitPoints
          .map((point) => ({ point, distance: this.distanceKm(coordinates.latitude, coordinates.longitude, point.latitude, point.longitude) }))
          .sort((a, b) => a.distance - b.distance)[0];
        const station = await this.prisma.lockerStation.findFirst({ where: { transitPointId: nearest.point.id, active: true }, select: { address: true } });
        const addressText = station?.address ? ` Address: ${station.address}` : ' The exact collection address has not yet been recorded.';
        return { reply: `There is no active SendIT transit point directly in ${area || message}. The nearest configured point is ${nearest.point.name}, approximately ${nearest.distance.toFixed(1)} km away.${addressText}`, suggestions: ['How does delivery work?', 'Track my parcel'] };
      }
      return { reply: `I could not find an active SendIT transit point for ${area || 'that area'} yet. Coverage is based on active transit points, so please contact support or check again after the area has been added.`, suggestions: ['Show active transit points', 'How does delivery work?'] };
    }

    if (!trackingIntent || !userId) return { reply: await this.answerGeneralQuestion(message), suggestions: ['How do I send a parcel?', 'How does locker collection work?', 'Track my parcel'] };
    const ownedParcels = await this.prisma.parcel.findMany({
      where: { deletedAt: null, OR: [{ senderId: userId }, { recipientId: userId }] },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: {
        id: true, trackingNumber: true, status: true, currentLocation: true,
        deliveryAddress: true, deliveryMethod: true, estimatedDeliveryTime: true,
        statusHistory: { orderBy: { timestamp: 'desc' }, take: 3, select: { status: true, location: true, notes: true, timestamp: true } },
      },
    });

    const parcel = ownedParcels[0];
    if (!parcel) return { reply: 'There are no parcels linked to your account yet. You can also paste a tracking ID here.', requiresTracking: true };
    if (/\b(recent|list|parcels)\b/i.test(message)) return { reply: ownedParcels.map((item) => `${item.trackingNumber}: ${this.label(item.status)}`).join('\n'), suggestions: ownedParcels.map((item) => item.trackingNumber) };

    const [lockerAssignment, lockerRequest] = await Promise.all([
      this.prisma.lockerAssignment.findFirst({ where: { parcelId: parcel.id, cancelledAt: null }, orderBy: { assignedAt: 'desc' } }),
      this.prisma.lockerRequest.findFirst({ where: { parcelId: parcel.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    if (lower.includes('locker') || lower.includes('collect') || lower.includes('pickup')) {
      const lockerText = lockerAssignment
        ? `A locker has been assigned. It was assigned on ${lockerAssignment.assignedAt.toLocaleString()}. Use the collection code shown in your parcel dashboard when you arrive.`
        : lockerRequest ? `Your locker request is ${lockerRequest.status.toLowerCase()}.` : 'No locker is assigned yet. The destination transit officer can assign one once the parcel is verified at destination.';
      return { reply: `${parcel.trackingNumber}: ${lockerText}`, parcel: this.summary(parcel), suggestions: ['Show latest update', 'Where is my parcel?'] };
    }
    if (lower.includes('history') || lower.includes('update') || lower.includes('transit')) {
      const events = parcel.statusHistory.map((event) => `${this.label(event.status)}${event.location ? ` at ${event.location}` : ''}${event.notes ? ` — ${event.notes}` : ''}`).join('; ');
      return { reply: `${parcel.trackingNumber} recent updates: ${events || 'No updates have been recorded yet.'}`, parcel: this.summary(parcel), suggestions: ['Where is my parcel?', 'Locker collection instructions'] };
    }
    return { reply: `${parcel.trackingNumber} is ${this.label(parcel.status)}${parcel.currentLocation ? ` and currently recorded at ${parcel.currentLocation}` : ''}.${parcel.estimatedDeliveryTime ? ` Estimated delivery: ${parcel.estimatedDeliveryTime.toLocaleString()}.` : ''}`, parcel: this.summary(parcel), suggestions: ['Show latest update', 'Locker collection instructions'] };
  }

  private async publicTracking(trackingNumber: string) {
    const parcel = await this.prisma.parcel.findFirst({
      where: { trackingNumber: { equals: trackingNumber, mode: 'insensitive' }, deletedAt: null },
      select: { trackingNumber: true, status: true, currentLocation: true, estimatedDeliveryTime: true },
    });
    if (!parcel) return { reply: 'No parcel was found with that tracking ID. Check the full ID and try again, or sign in to view your parcels.', requiresTracking: true };
    return {
      reply: `${parcel.trackingNumber} is ${this.label(parcel.status)}${parcel.currentLocation ? ` and currently recorded at ${parcel.currentLocation}` : ''}.${parcel.estimatedDeliveryTime ? ` Estimated delivery: ${parcel.estimatedDeliveryTime.toISOString()}.` : ''} Sign in to your parcel dashboard for private collection instructions.`,
      trackingNumber: parcel.trackingNumber,
      suggestions: ['Show latest update', 'How does locker collection work?'],
    };
  }

  private summary(parcel: { trackingNumber: string; status: unknown; currentLocation: string | null; deliveryAddress: string }) {
    return { trackingNumber: parcel.trackingNumber, status: this.label(String(parcel.status)), currentLocation: parcel.currentLocation, destination: parcel.deliveryAddress };
  }
  private label(value: unknown) { return String(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
  private isDeliveryAreaQuestion(message: string) {
    return /\b(deliver|delivery|serve|service|coverage|ship|nearest)\b/.test(message)
      && /\b(to|in|around|near|area|location|where)\b/.test(message);
  }
  private matchesTransitPoint(question: string, name: string) {
    const normalisedName = name.toLowerCase().replace(/transit point/g, '').trim();
    if (normalisedName && question.includes(normalisedName)) return true;
    return normalisedName.split(/\s+/).filter((word) => word.length >= 4).some((word) => question.includes(word));
  }
  private areaFromQuestion(message: string) {
    return message.match(/\b(?:to|in|around|near)\s+([\p{L}\d][\p{L}\d\s-]{1,40})/iu)?.[1]?.replace(/[?!.].*$/, '').trim();
  }
  private async geocode(query: string): Promise<{ latitude: number; longitude: number } | null> {
    try {
      const response = await axios.get<Array<{ lat: string; lon: string }>>('https://nominatim.openstreetmap.org/search', {
        params: { q: `${query}, Kenya`, format: 'jsonv2', limit: 1 },
        headers: { 'User-Agent': 'SendIT-Transit-Lookup/1.0' }, timeout: 4000,
      });
      const result = response.data[0];
      if (!result) return null;
      const latitude = Number(result.lat), longitude = Number(result.lon);
      return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
    } catch { return null; }
  }
  private distanceKm(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number) {
    const radians = (value: number) => value * Math.PI / 180;
    const a = Math.sin(radians(latitudeB - latitudeA) / 2) ** 2 + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(radians(longitudeB - longitudeA) / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  private async answerGeneralQuestion(question: string): Promise<string> {
    const known = SUPPORT_KNOWLEDGE.find((entry) => entry.match.test(question));
    if (known) return known.answer;
    const fallback = 'I do not have a verified answer for that. I can help with tracking, delivery coverage, transit points, lockers, and collection instructions.';
    if (process.env.OLLAMA_ENABLED?.toLowerCase() !== 'true') return fallback;
    const source = [
      'SendIT tracking: customers can track a parcel with its tracking number.',
      'Delivery coverage is determined by active SendIT transit points.',
      'A locker is assigned only after the parcel is verified at its destination transit point.',
      'Collection instructions and parcel facts must be retrieved from the secure SendIT database.',
      'For any question not answered by these facts, say that you do not have a verified answer and advise contacting SendIT support.',
    ].join('\n') + '\n' + SUPPORT_SOURCE;
    try {
      const response = await axios.post<{ message?: { content?: string } }>(
        `${process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'}/api/chat`,
        { model: process.env.OLLAMA_MODEL ?? 'qwen3.5:0.8b', stream: false, think: false, keep_alive: '1m', options: { num_ctx: 2048, num_predict: 180, temperature: 0.2 }, messages: [
          { role: 'system', content: `You are SendIT Assist. Answer only from VERIFIED SOURCE below. Never invent policies, locations, parcel facts, prices, or collection codes. If the source does not answer, reply exactly: "I do not have a verified answer for that. Please contact SendIT support."\n\nVERIFIED SOURCE:\n${source}` },
          { role: 'user', content: question },
        ] },
        { timeout: 60000 },
      );
      const answer = response.data.message?.content?.trim();
      return answer && answer.length <= 700 ? answer : fallback;
    } catch { return fallback; }
  }
}
