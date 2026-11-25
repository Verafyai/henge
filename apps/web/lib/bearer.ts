import { apiError } from './api';
import { NO_STORE } from './api-auth';
import { authenticate, type Authed } from './auth/oauth';

/** Wraps a client endpoint: bearer token required, responses never cached. */
export function withBearer<C>(handler: (req: Request, auth: Authed, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C) => {
    const auth = await authenticate(req);
    if (!auth) {
      const res = apiError(401, 'unauthorized', 'Sign in again.');
      res.headers.set('www-authenticate', 'Bearer');
      return res;
    }
    const res = await handler(req, auth, ctx);
    for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v);
    return res;
  };
}
