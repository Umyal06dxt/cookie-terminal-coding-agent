import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';

/** A scripted reply: a response, a thrown network error, or a function producing either. */
export type Reply =
  | Response
  | Error
  | ((request: Request) => Response | Promise<Response>);

export interface FakeFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  requests: Request[];
}

/** Replays `replies` in order; a request past the end of the script fails the test loudly. */
export function fakeFetch(replies: Reply[]): FakeFetch {
  const queue = [...replies];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
    fn.requests.push(request);
    const next = queue.shift();
    if (next === undefined)
      throw new Error(`fakeFetch: unexpected request to ${request.url}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(request) : next;
  }) as FakeFetch;
  fn.requests = [];
  return fn;
}

export function readFixture(...path: string[]): string {
  return readFileSync(join(import.meta.dir, 'fixtures', ...path), 'utf8');
}

export function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** An OpenAI-style error envelope, as Command Code sends on Chat Completions. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(
    status,
    { error: { message, type: code, code, param: null } },
    headers,
  );
}

export const TEST_BASE_URL = 'https://api.commandcode.test/provider/v1';

export function testClient(fetch: FakeFetch): OpenAI {
  return new OpenAI({
    apiKey: 'test-key-not-real',
    baseURL: TEST_BASE_URL,
    maxRetries: 0,
    fetch,
  });
}
