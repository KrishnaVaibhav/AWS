// /api/* router. CloudFront -> Lambda Function URL (AWS_IAM + OAC).
//
// Two rules that come with that path:
// - OAC signs every request and overwrites Authorization, so the browser
//   sends its Cognito token in the x-auth-token header instead.
// - POST/PUT bodies need x-amz-content-sha256 (hex SHA-256 of the body);
//   Lambda URLs reject unsigned payloads.

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  // serverTime lets clients sync countdowns to the clock that decides bids.
  body: JSON.stringify({ ...body, serverTime: Date.now() }),
});

const routes = {
  'GET /api/health': () => json(200, { ok: true, stage: process.env.STAGE }),
};

export const handler = async (event) => {
  const route = `${event.requestContext.http.method} ${event.rawPath}`;
  const fn = routes[route];
  return fn ? fn(event) : json(404, { error: 'not_found', route });
};
