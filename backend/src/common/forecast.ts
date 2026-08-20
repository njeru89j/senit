export function forecastWeeklyVolume(weeklyCounts: number[]) {
  if (weeklyCounts.length !== 4) throw new Error('Four weekly observations are required');
  const weights = [0.1, 0.2, 0.3, 0.4];
  const predictedVolume = Math.max(0, Math.ceil(weeklyCounts.reduce((sum, value, index) => sum + value * weights[index], 0)));
  const mean = weeklyCounts.reduce((sum, value) => sum + value, 0) / weeklyCounts.length;
  const deviation = Math.sqrt(weeklyCounts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / weeklyCounts.length);
  const confidence = Math.max(0.35, Math.min(0.95, 0.9 - deviation / Math.max(1, mean) * 0.2));
  return { predictedVolume, confidence: Number(confidence.toFixed(2)), recommendedCapacity: Math.ceil(predictedVolume * 1.2) };
}
