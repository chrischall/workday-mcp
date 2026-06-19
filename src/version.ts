// Single source of truth for the server version. release-please bumps the
// literal on this line (registered in release-please-config.json extra-files);
// every other module imports VERSION from here so there's one marker to track.
export const VERSION = '0.1.0'; // x-release-please-version
