import { forecastWeeklyVolume } from './forecast';

describe('forecastWeeklyVolume', () => {
  it('weights recent demand more heavily', () => expect(forecastWeeklyVolume([2, 2, 2, 10]).predictedVolume).toBe(6));
  it('adds a twenty-percent capacity buffer', () => expect(forecastWeeklyVolume([5, 5, 5, 5]).recommendedCapacity).toBe(6));
  it('reduces confidence for volatile demand', () => expect(forecastWeeklyVolume([0, 12, 0, 12]).confidence).toBeLessThan(forecastWeeklyVolume([6, 6, 6, 6]).confidence));
});
