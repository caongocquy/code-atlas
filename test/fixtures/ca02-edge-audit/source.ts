export function target(): number {
  return 1;
}

export function outer(): number {
  function target(): number {
    return 2;
  }
  return target();
}

export class First {
  work(): number {
    return 1;
  }
}

export class Second {
  work(): number {
    return 2;
  }
}

export function invokeKnown(receiver: First): number {
  return receiver.work();
}

export function invokeUnknown(receiver: unknown): unknown {
  return (receiver as { work(): unknown }).work();
}

export function invokeTwice(): number {
  target();
  return target();
}
