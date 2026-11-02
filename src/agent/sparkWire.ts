import { z } from 'zod';

/** The model the fitting agent runs on (spec §4). */
export const SPARK_AGENT_MODEL = 'muse-spark-1.3';

/**
 * The slice of the Meta Model API's Responses API the agent uses (OpenAI
 * compatible, dev.meta.ai): function tools, and a stateless conversation
 * where every turn resends the earlier items. Nothing else is sent, so the
 * local proxy can refuse anything that is not this shape.
 */
export const functionToolSchema = z.strictObject({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  strict: z.boolean(),
});

const inputMessageSchema = z.strictObject({
  type: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

export const functionCallSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string().min(1),
  name: z.string(),
  arguments: z.string(),
});

const functionCallOutputSchema = z.strictObject({
  type: z.literal('function_call_output'),
  call_id: z.string().min(1),
  output: z.string(),
});

export const inputItemSchema = z.union([inputMessageSchema, functionCallSchema, functionCallOutputSchema]);
export type InputItem = z.infer<typeof inputItemSchema>;

export const sparkRequestSchema = z.strictObject({
  model: z.literal(SPARK_AGENT_MODEL),
  instructions: z.string(),
  input: z.array(inputItemSchema).min(1).max(64),
  tools: z.array(functionToolSchema).max(4),
  tool_choice: z.literal('required'),
  parallel_tool_calls: z.literal(false),
});
export type SparkRequest = z.infer<typeof sparkRequestSchema>;

const outputTextSchema = z.object({ type: z.literal('output_text'), text: z.string() });
const outputMessageSchema = z.object({
  type: z.literal('message'),
  content: z.array(z.union([outputTextSchema, z.object({ type: z.string() })])),
});

/** A reply: function calls and messages are read; any other output item (reasoning, say) is kept but ignored. */
export const sparkResponseSchema = z.object({
  output: z.array(z.union([functionCallSchema, outputMessageSchema, z.object({ type: z.string() })])),
});
export type SparkResponse = z.infer<typeof sparkResponseSchema>;
export type FunctionCall = z.infer<typeof functionCallSchema>;

/** Sends one Responses request and returns the raw JSON reply. The agent validates it. */
export type SparkTransport = (request: SparkRequest) => Promise<unknown>;

/**
 * The browser's transport: posts to the app's own `/api/spark`, which adds
 * the API key server-side (the Vite dev server in `vite.config.ts` for now),
 * so the key never reaches the page.
 */
export function fetchTransport(url = '/api/spark', fetchImpl: typeof fetch = fetch): SparkTransport {
  return async (request) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} answered ${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${url} did not answer JSON`);
    }
  };
}

export function functionCalls(response: SparkResponse): FunctionCall[] {
  return response.output.flatMap((item) => {
    const call = functionCallSchema.safeParse(item);
    return call.success ? [call.data] : [];
  });
}

export function outputText(response: SparkResponse): string {
  return response.output
    .flatMap((item) => {
      const message = outputMessageSchema.safeParse(item);
      if (!message.success) return [];
      return message.data.content.flatMap((c) => ('text' in c && typeof c.text === 'string' ? [c.text] : []));
    })
    .join('');
}
