/**
 * Marks methods that used to send telemetry.
 *
 * Rest Client sends nothing anywhere: the decorator is kept, empty, so ten
 * controllers stay untouched and there is a record of where it used to be.
 */
export function trace(_eventName: string): MethodDecorator {
    return (_target, _propertyKey: string | symbol, descriptor: PropertyDescriptor) => descriptor;
}
