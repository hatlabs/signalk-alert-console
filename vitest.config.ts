import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    // A zone with a UTC offset, so local-versus-UTC date bugs fail everywhere,
    // CI runners included.
    env: { TZ: 'America/New_York' }
  }
})
