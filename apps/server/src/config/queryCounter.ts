/**
 * Opt-in DB query counting for performance diagnosis (`LOG_DB_QUERY_COUNT=true`).
 *
 * The request logger reports how many queries each request ran — the number that
 * matters most against a remote database, where every query is a network round
 * trip. Exact when requests run one at a time; approximate under concurrent load,
 * since Prisma's query events do not carry the request's async context.
 *
 * Its own module so the request logger does not depend on the Prisma client (and
 * tests that mock the database do not have to mock this).
 */
export const dbQueryCounter = { enabled: process.env.LOG_DB_QUERY_COUNT === "true", value: 0 };
