export type CorsAuthConfig = {
  authToken: string;
  allowedCorsOrigin: string;
};

export function createCorsAuth(config: CorsAuthConfig) {
  function getRequestToken(request: Request) {
    const header = request.headers.get("authorization") || request.headers.get("Authorization");
    if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
    return new URL(request.url).searchParams.get("token")?.trim() || "";
  }

  function isAuthorizedRequest(request: Request) {
    if (!config.authToken) return true;
    return getRequestToken(request) === config.authToken;
  }

  function corsHeaders() {
    return {
      "access-control-allow-origin": config.allowedCorsOrigin,
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-expose-headers": "set-auth-token",
      ...(config.allowedCorsOrigin === "*" ? {} : { "access-control-allow-credentials": "true" }),
    };
  }

  function withCors(response: Response) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  function unauthorizedResponse() {
    return withCors(
      Response.json(
        { ok: false, error: "Unauthorized", code: "AUTH_REQUIRED", recoverable: true },
        { status: 401 },
      ),
    );
  }

  function optionsResponse() {
    return withCors(new Response(null, { status: 204 }));
  }

  return { isAuthorizedRequest, withCors, unauthorizedResponse, optionsResponse };
}
