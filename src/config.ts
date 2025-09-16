import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().optional(),
  redisUrl: z.string().nonempty().optional(),
  presenceTtlMs: z.coerce.number().int().positive().optional(),
  reaperIntervalMs: z.coerce.number().int().positive().optional(),
  reaperLookbackMs: z.coerce.number().int().positive().optional(),
});

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_REAPER_INTERVAL_MS = 3_000;

const parsed = ConfigSchema.parse({
  port: process.env.PORT,
  redisUrl: process.env.REDIS_URL,
  presenceTtlMs: process.env.PRESENCE_TTL_MS,
  reaperIntervalMs: process.env.PRESENCE_REAPER_INTERVAL_MS,
  reaperLookbackMs: process.env.PRESENCE_REAPER_LOOKBACK_MS,
});

export interface AppConfig {
  port: number;
  redisUrl: string;
  presenceTtlMs: number;
  reaperIntervalMs: number;
  reaperLookbackMs: number;
}

export const config: AppConfig = {
  port: parsed.port ?? 3000,
  redisUrl: parsed.redisUrl ?? "redis://localhost:6379",
  presenceTtlMs: parsed.presenceTtlMs ?? DEFAULT_TTL_MS,
  reaperIntervalMs: parsed.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS,
  reaperLookbackMs:
    parsed.reaperLookbackMs ?? (parsed.presenceTtlMs ?? DEFAULT_TTL_MS) * 2,
};
