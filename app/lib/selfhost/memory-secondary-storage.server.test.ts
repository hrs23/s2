import { describe, expect, it } from "vitest";
import { createMemorySecondaryStorage } from "./memory-secondary-storage.server";

describe("createMemorySecondaryStorage", () => {
  it("supports get/set/delete", async () => {
    const storage = createMemorySecondaryStorage();
    await storage.set("session:one", "stored");

    await expect(storage.get("session:one")).resolves.toBe("stored");

    await storage.delete("session:one");
    await expect(storage.get("session:one")).resolves.toBeNull();
  });

  it("expires entries after the ttl", async () => {
    const storage = createMemorySecondaryStorage();
    await storage.set("rate-limit:one", "1", 0.001);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(storage.get("rate-limit:one")).resolves.toBeNull();
  });
});
