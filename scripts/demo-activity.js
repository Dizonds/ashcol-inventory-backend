import { randomInt } from "node:crypto";

// Plan irregular demo activity against a copy of the opening stock balances.
export function planDemoActivity(items, dayAt) {
  const balances = new Map(items.map((item) => [String(item._id), item.quantity]));
  const activity = [];
  for (let daysAgo = 30; daysAgo >= 1; daysAgo -= 1) {
    if (randomInt(100) < 14) continue;
    const deliveryChance = [15, 45, 80][randomInt(3)];
    const count = randomInt(1, 6);
    for (let index = 0; index < count; index += 1) {
      const item = items[randomInt(items.length)];
      const key = String(item._id);
      const balance = balances.get(key);
      // Leave room for reserved materials and the separately seeded van loadout.
      const floor = ["FRN-R410A-11.3", "CP-PIPE-1/4"].includes(item.sku) ? 6 : 0;
      const inbound = randomInt(100) < deliveryChance || balance <= floor;
      const bulk = ["METER", "FOOT", "KG", "LITER"].includes(item.unitOfMeasure);
      const requested = randomInt(1, bulk ? 22 : 10);
      const delta = inbound ? requested : -Math.min(requested, balance - floor);
      if (!delta) continue;
      balances.set(key, balance + delta);
      // Day-one events precede the seeded transfer and request issue at 10 AM.
      const hour = randomInt(8, daysAgo === 1 ? 10 : 18);
      const createdAt = new Date(dayAt(daysAgo, hour).getTime() + randomInt(60) * 60000 + randomInt(60) * 1000);
      activity.push({
        item, delta, movementType: inbound ? "STOCK_IN" : "STOCK_OUT", createdAt,
        reason: inbound ? "Demo activity: supplier delivery" : "Demo activity: client service dispatch",
      });
    }
  }
  // Preserve each item's planned order even when several events share a day.
  // Assign chronologically sorted times to each day's already planned events.
  for (let start = 0; start < activity.length;) {
    let end = start + 1;
    const dateKey = activity[start].createdAt.toISOString().slice(0, 10);
    while (end < activity.length && activity[end].createdAt.toISOString().slice(0, 10) === dateKey) end += 1;
    const times = activity.slice(start, end).map((entry) => entry.createdAt).sort((a, b) => a - b);
    for (let index = start; index < end; index += 1) activity[index].createdAt = times[index - start];
    start = end;
  }
  return activity;
}
