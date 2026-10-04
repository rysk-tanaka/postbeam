/**
 * グローバルの fetch を呼ぶラッパー。
 *
 * Workers では fetch をプロパティとして保持して `this.fetcher(...)` のように
 * 呼ぶと「Illegal invocation」になるため、必ずこの関数経由で既定値にする。
 */
export const globalFetch: typeof fetch = (input, init) => fetch(input, init);
