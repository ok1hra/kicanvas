/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

export function no_self_recursion(
    target: any,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
) {
    const fn = descriptor.value;

    // Tracked per instance: calling the same method on a different object
    // (e.g. one viewer's selection changing another's) isn't recursion.
    const running = new WeakSet<object>();

    descriptor.value = function (this: object, ...args: any[]) {
        if (running.has(this)) {
            return;
        }
        running.add(this);
        try {
            return fn.apply(this, args);
        } finally {
            running.delete(this);
        }
    };
}
