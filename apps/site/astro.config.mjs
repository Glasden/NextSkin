import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, passthroughImageService } from 'astro/config'

export default defineConfig({
  site: 'https://nextskin.org',
  // 图片原样发布，不装 sharp（见 pnpm-workspace.yaml 的 overrides）
  image: { service: passthroughImageService() },
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
})
