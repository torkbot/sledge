declare const eventRefBrand: unique symbol;

export type EventRef<TEventName extends string> = {
  readonly eventName: TEventName;
  readonly eventId: number;
  readonly [eventRefBrand]: {
    readonly eventName: TEventName;
  };
};

export function createEventRef<TEventName extends string>(
  eventName: TEventName,
  eventId: number,
): EventRef<TEventName> {
  return {
    eventName,
    eventId,
  } as EventRef<TEventName>;
}
