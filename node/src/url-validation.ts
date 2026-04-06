const ALLOWED_DOMAIN_SUFFIXES = ['.webex.com', '.wbx2.com', '.ciscospark.com'];

export function validateWebexUrl(rawUrl: string, requiredProtocol: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== requiredProtocol) {
    throw new Error(`URL protocol must be ${requiredProtocol}, got ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  const isAllowed = ALLOWED_DOMAIN_SUFFIXES.some(suffix => host.endsWith(suffix));
  if (!isAllowed) {
    throw new Error(`URL host ${host} is not a recognized Webex domain`);
  }
}
