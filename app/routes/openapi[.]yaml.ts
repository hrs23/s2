// GET /openapi.yaml — Serve the OpenAPI spec

import spec from "../../openapi.yaml?raw";

export function loader() {
  return new Response(spec, {
    headers: {
      "Content-Type": "text/yaml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
