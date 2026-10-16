2026-10-16 · Step 0.2 · spec added · next: 0.3
2026-10-16 · Step 0.3 · skeleton: package scripts, strict tsconfig, Biome, src/cli.ts (--version/--help/unknown flag → exit 2) + test/cli.test.ts, CI on ubuntu/macos/windows, .gitignore/.gitattributes; removed bun-init index.ts · next: 0.4

toy-repo baseline: 62faf21
2026-10-16 · Step 0.4 · config loader (src/config: user+project cookie.toml, zod schema, file/field error messages) and provider (src/provider: client, models catalog with 24h cache + offline fallback + startup model check, streamChat typed events with tool-call accumulation, typed errors, retry with backoff/retry-after/abort); 4 SSE fixtures (3 requested + mid-stream error), 70 new tests, scripts/smoke.ts · left: run smoke.ts against the real API to confirm /models field names and cache-token fields; prepareProvider not yet wired into cli.ts · next: 0.5
