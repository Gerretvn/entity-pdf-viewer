import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // WICHTIG: Ersetze 'entity-pdf-viewer' durch den exakten Namen deines GitHub-Repos!
  // Wenn dein Repo https://github.com/deinname/meine-app ist, dann schreibe '/meine-app/'
  base: '/entity-pdf-viewer/', 
})