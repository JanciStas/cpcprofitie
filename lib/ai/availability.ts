// Whether live AI generation is possible in this deployment.
//
// Without an AI Gateway key the route used to stream a canned "mock" listing
// in production too, so beta users were shown template text as if an AI had
// written it. Pages and the nav hide the feature instead; local development
// keeps the mock, which is what it is for.
export function aiListingsAvailable(): boolean {
  if (process.env.VERCEL_ENV !== 'production') return true;
  return Boolean(process.env.AI_GATEWAY_API_KEY);
}
