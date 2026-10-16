import { z } from 'zod';

export const MODEL_KEYS = ['workhorse', 'planner', 'longctx'] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];

const modelId = z
  .string({ error: 'must be a model id string' })
  .trim()
  .min(1, 'must be a non-empty model id');
const positiveInt = z
  .number({ error: 'must be a number' })
  .int('must be a whole number')
  .positive('must be greater than 0');

const providerSchema = z.strictObject({
  base_url: z
    .url({
      error:
        'must be a full URL such as https://api.commandcode.ai/provider/v1',
    })
    .default('https://api.commandcode.ai/provider/v1'),
  api_key_env: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name')
    .default('COMMANDCODE_API_KEY'),
});

const modelsSchema = z.strictObject({
  workhorse: modelId,
  planner: modelId,
  longctx: modelId,
});

const roleTarget = z.enum(MODEL_KEYS, {
  error: (issue) =>
    `must be one of ${MODEL_KEYS.join(', ')} (got ${JSON.stringify(issue.input)})`,
});

// Defaults follow the role table in docs/design.md ("Models").
const rolesSchema = z.strictObject({
  main: roleTarget.default('workhorse'),
  explorer: roleTarget.default('workhorse'),
  planner: roleTarget.default('planner'),
  reviewer: roleTarget.default('planner'),
});

const limitsSchema = z.strictObject({
  max_turns: positiveInt.default(40),
  max_parallel_tools: positiveInt.default(8),
  request_timeout_ms: positiveInt.default(120_000),
});

export const configSchema = z.strictObject({
  provider: providerSchema.prefault({}),
  models: modelsSchema,
  roles: rolesSchema.prefault({}),
  limits: limitsSchema.prefault({}),
});

export type CookieConfig = z.infer<typeof configSchema>;
export type Role = keyof CookieConfig['roles'];
