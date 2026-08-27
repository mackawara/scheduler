export function minuteClaimTimes(startsAt: Date, endsAt: Date): Date[] {
  const result: Date[] = [];
  for (let cursor = startsAt.getTime(); cursor < endsAt.getTime(); cursor += 60_000) result.push(new Date(cursor));
  return result;
}
