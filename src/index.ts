import type { Env } from "./config";
import { handleRequest } from "./proxy";

export { ChunkSession } from "./chunk-session";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
