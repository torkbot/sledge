declare const eventRefBrand: unique symbol;

export type EventRef<TEventName extends string | object> = {
  readonly eventName: TEventName;
  readonly eventId: number;
  readonly [eventRefBrand]: {
    readonly eventName: TEventName;
  };
};

export function createEventRef<TEventName extends string | object>(
  eventName: TEventName,
  eventId: number,
): EventRef<TEventName> {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    throw new Error("event reference id must be a positive safe integer");
  }

  return {
    eventName,
    eventId,
  } as EventRef<TEventName>;
}
