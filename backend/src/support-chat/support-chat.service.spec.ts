import axios from 'axios';
import { SupportChatService } from './support-chat.service';
import { OptionalChatAuthGuard } from './optional-chat-auth.guard';

describe('Support chat access and project knowledge', () => {
  const prisma = {
    parcel: { findMany: jest.fn(), findFirst: jest.fn() },
    transitPoint: { findMany: jest.fn() },
  };
  let service: SupportChatService;
  beforeEach(() => { jest.clearAllMocks(); service = new SupportChatService(prisma as any); });

  it('answers guest project questions without looking up any private parcels', async () => {
    expect((await service.reply(undefined, 'How do I send a parcel?')).reply).toContain('/user/create-parcel');
    expect(prisma.parcel.findMany).not.toHaveBeenCalled();
    expect(prisma.transitPoint.findMany).not.toHaveBeenCalled();
  });

  it('asks guests for a tracking ID or login', async () => {
    const result = await service.reply(undefined, 'Where is my parcel?');
    expect(result.reply).toContain('tracking ID');
    expect(result.reply).toContain('sign in');
    expect(prisma.parcel.findMany).not.toHaveBeenCalled();
  });

  it('looks up an exact tracking ID without exposing addresses, notes or collection codes', async () => {
    prisma.parcel.findFirst.mockResolvedValue({ trackingNumber: 'SENDIT12345678ABCD', status: 'IN_TRANSIT', currentLocation: 'Nairobi', estimatedDeliveryTime: null });
    const result = await service.reply(undefined, 'Track SENDIT12345678ABCD');
    expect(result.reply).toContain('Nairobi');
    expect(prisma.parcel.findFirst).toHaveBeenCalledWith({
      where: { trackingNumber: { equals: 'SENDIT12345678ABCD', mode: 'insensitive' }, deletedAt: null },
      select: { trackingNumber: true, status: true, currentLocation: true, estimatedDeliveryTime: true },
    });
    expect(prisma.parcel.findMany).not.toHaveBeenCalled();
  });

  it('keeps a provided tracking ID for follow-up status questions', async () => {
    prisma.parcel.findFirst.mockResolvedValue(null);
    expect((await service.reply(undefined, 'Show latest update', 'SENDIT12345678ABCD')).reply).toContain('No parcel');
    expect(prisma.parcel.findFirst).toHaveBeenCalled();
  });

  it('scopes account parcel lists to the authenticated sender or recipient', async () => {
    prisma.parcel.findMany.mockResolvedValue([]);
    await service.reply('customer-1', 'Show my recent parcels');
    expect(prisma.parcel.findMany.mock.calls[0][0].where).toEqual({ deletedAt: null, OR: [{ senderId: 'customer-1' }, { recipientId: 'customer-1' }] });
  });

  it('answers general questions for logged-in users without selecting their latest parcel', async () => {
    expect((await service.reply('customer-1', 'How do I reset my password?')).reply).toContain('/reset');
    expect(prisma.parcel.findMany).not.toHaveBeenCalled();
  });

  it('rejects malformed input', async () => {
    await expect(service.reply(undefined, 42 as any)).rejects.toThrow();
    await expect(service.reply(undefined, 'status', '*')).rejects.toThrow();
  });

  it('uses project context and low-memory settings for model answers', async () => {
    const old = process.env.OLLAMA_ENABLED;
    process.env.OLLAMA_ENABLED = 'true';
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { message: { content: 'Verified help.' } } });
    try {
      expect((await service.reply(undefined, 'Explain this platform in simple terms')).reply).toBe('Verified help.');
      expect(post.mock.calls[0][1]).toEqual(expect.objectContaining({ think: false, options: expect.objectContaining({ num_ctx: 2048 }) }));
      expect(JSON.stringify(post.mock.calls[0][1])).toContain('/user/create-parcel');
    } finally { post.mockRestore(); if (old === undefined) delete process.env.OLLAMA_ENABLED; else process.env.OLLAMA_ENABLED = old; }
  });

  it('allows anonymous requests but validates every supplied credential', async () => {
    const auth = { canActivate: jest.fn().mockRejectedValue(new Error('Invalid token')) };
    const guard = new OptionalChatAuthGuard(auth as any);
    const context = (headers: object) => ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as any;
    expect(guard.canActivate(context({}))).toBe(true);
    await expect(guard.canActivate(context({ authorization: 'Bearer invalid' }))).rejects.toThrow('Invalid token');
  });
});
