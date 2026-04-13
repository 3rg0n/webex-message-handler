/**
 * Convert a Mercury activity UUID to a Webex REST API ID.
 *
 * Mercury uses raw UUIDs; the REST API uses base64-encoded
 * `ciscospark://us/{type}/{uuid}` URIs.
 *
 * @param uuid  Mercury UUID (e.g. activity.id)
 * @param type  Resource type — 'MESSAGE', 'PEOPLE', 'ROOM'
 * @returns     REST API–compatible ID string
 */
export function toRestId(uuid: string, type: 'MESSAGE' | 'PEOPLE' | 'ROOM'): string {
  return Buffer.from(`ciscospark://us/${type}/${uuid}`).toString('base64');
}

/**
 * Convert a Webex REST API ID back to a raw UUID.
 *
 * @param restId  Base64-encoded REST API ID
 * @returns       The raw UUID portion
 */
export function fromRestId(restId: string): string {
  const decoded = Buffer.from(restId, 'base64').toString('utf-8');
  const lastSlash = decoded.lastIndexOf('/');
  if (lastSlash === -1) {
    throw new Error(`Invalid REST ID format: ${restId}`);
  }
  return decoded.substring(lastSlash + 1);
}
