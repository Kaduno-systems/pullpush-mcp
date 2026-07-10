import { z } from 'zod';

const envSchema = z.object({
  PULLPUSH_API_KEY: z.string().min(1, 'PULLPUSH_API_KEY is required. Get your key from the PullPush admin panel.'),
  PULLPUSH_API_URL: z.string().url().default('https://api.pullpush.ai'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    process.stderr.write(
      `[kaduno-pullpush-mcp] Configuration error:\n${errors.join('\n')}\n\n` +
        `Required env vars:\n` +
        `  PULLPUSH_API_KEY  — Your PullPush API key (tenant, org, or admin)\n` +
        `                     Get one from your PullPush admin panel → Settings → API Keys\n\n` +
        `Optional:\n` +
        `  PULLPUSH_API_URL  — API base URL (default: https://api.pullpush.ai)\n`,
    );
    process.exit(1);
  }

  return result.data;
}
