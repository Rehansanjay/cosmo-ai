import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { RealtimeClient } from 'cosmo-ai/server';

// The app's own /token route, dev-server edition: mints a short-lived
// end-user token off COSMO_API_KEY, else the `cosmo init` credential. The
// deployed form is the same mint call in a real route — see the token-server
// example and the quickstart's "Ship it".
function tokenRoute(): Plugin {
  let client: RealtimeClient | null = null;
  return {
    name: 'token-route',
    configureServer(server) {
      // Mint against the backend the page will use. The browser reads
      // VITE_COSMO_BASE_URL; this client would otherwise resolve its own from
      // COSMO_API_KEY / the cosmo-login credential, so pointing the page at a
      // non-production backend would mint on one host and 401 on the other.
      // A credential issued by a different origin now fails loudly here.
      const baseUrl = server.config.env.VITE_COSMO_BASE_URL;
      if (typeof baseUrl === 'string' && baseUrl.trim() !== '') {
        process.env.COSMO_BASE_URL = baseUrl.trim();
      }
      client ??= new RealtimeClient({});
      server.middlewares.use('/token', (req, res) => {
        const header = req.headers['x-external-user-id'];
        const user = (Array.isArray(header) ? header[0] : header) ?? 'dev-user';
        void client!.mintToken(user).then(
          (minted) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ jwt: minted.jwt, expires_at: minted.expiresAt }));
          },
          (err) => {
            res.statusCode = 500;
            res.end(String(err));
          },
        );
      });
    },
  };
}


export default defineConfig({
  plugins: [react(), tokenRoute()],
});
