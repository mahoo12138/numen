import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const base = process.env.DOCS_BASE || '/'
const origin = 'http://127.0.0.1:4178'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  outputDir: '../test-results/docs',
  timeout: 30_000,
  use: {
    baseURL: `${origin}${base}`,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 960 },
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm build && pnpm preview --port 4178 --strictPort',
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    url: `${origin}${base}`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
})
