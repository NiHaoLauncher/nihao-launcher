export type Result<T, E> = 
    | { tag: 'ok'; value: T }
    | { tag: 'err'; error: E, message: string | null }
    | { tag: 'pending' };

export function Ok<T, E>(value: T): Result<T, E> {
    return { tag: 'ok', value };
}
export function Err<T, E>(error: E, message?: string): Result<T, E> {
    return { tag: 'err', error, message: message ?? null };
}
export function Pending<T, E>(): Result<T, E> {
    return { tag: 'pending' };
}

export function isOk<T, E>(result: Result<T, E>): result is { tag: 'ok'; value: T } {
    return result.tag === 'ok';
}
export function isErr<T, E>(result: Result<T, E>): result is { tag: 'err'; error: E; message: string } {
    return result.tag === 'err';
}
export function isPending<T, E>(result: Result<T, E>): result is { tag: 'pending' } {
    return result.tag === 'pending';
}

export function unwrap<T, E>(result: Result<T, E>): T {
    if (result.tag === 'ok') return result.value;
    if (result.tag === 'pending') throw new Error("Called unwrap() on Pending");
    throw new Error(`Called unwrap() on Err: ${JSON.stringify(result.error)}`);
}

export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
    return result.tag === 'ok' ? result.value : defaultValue;
}
export function errMsg<T, E>(result: Result<T, E>): string | null {
    return result.tag === 'err' ? result.message : null;
}