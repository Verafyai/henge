import { communityRoute } from './router';

type Params = Promise<Record<string, string | string[] | undefined>>;

/** A Next route handler that forwards `<prefix>/<segments>` to the community router. */
export function communityHandler(prefix: string, param: string) {
  return async (req: Request, { params }: { params: Params }) => {
    const v = (await params)[param];
    const segs = v === undefined ? [] : Array.isArray(v) ? v : [v];
    return communityRoute(req, [prefix, ...segs.map((s) => encodeURIComponent(s))].join('/'));
  };
}
