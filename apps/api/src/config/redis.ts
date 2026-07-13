import IORedis from "ioredis";
import { env } from "./env.js";

let _connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!_connection) {
    _connection = new IORedis(env.REDIS_URL!, { maxRetriesPerRequest: null });
  }
  return _connection;
}

export async function closeRedis(): Promise<void> {
  if (_connection) {
    await _connection.quit();
    _connection = null;
  }
}
