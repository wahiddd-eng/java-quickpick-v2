import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android shell for the shop tablet. Build the web app with the API address baked in, then sync:
 *   VITE_API_URL=https://api.your-domain npm run build -w @qp2/vendor-app && npx cap sync android
 * See README.md in this folder.
 */
const config: CapacitorConfig = {
  appId: 'in.javaquickpick.vendor',
  appName: 'QuickPick Shop',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  android: { allowMixedContent: false },
};

export default config;
