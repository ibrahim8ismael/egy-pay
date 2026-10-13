export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  nextId(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const uuidGenerator: IdGenerator = {
  nextId: () => globalThis.crypto.randomUUID(),
};
