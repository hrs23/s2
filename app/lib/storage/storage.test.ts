import { MemoryStorageAdapter } from "~/lib/storage/memory.server";
import { describeStorageAdapterContract } from "./__tests__/storage-contract";

describeStorageAdapterContract("MemoryStorageAdapter", {
  create() {
    return new MemoryStorageAdapter();
  },
});
