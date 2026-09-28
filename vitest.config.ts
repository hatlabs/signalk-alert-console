import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // A zone with a UTC offset, so local-versus-UTC date bugs fail everywhere,
    // CI runners included.
    env: { TZ: 'America/New_York' },
    // Node 25+ ships its own localStorage global, which shadows happy-dom's
    // and is undefined without --localstorage-file.
    poolOptions: { forks: { execArgv: ['--no-experimental-webstorage'] } }
  }
})
