/**
 * Who acted.
 *
 * Lives in its own module because both the authority ceilings (authority.ts)
 * and the event schema (event.ts) need it. Declaring it twice produced two
 * types with one name — caught by the compiler on the first typecheck, which is
 * the argument for ADR-0002's strictness in miniature.
 */

export const ACTOR_KINDS = ['HUMAN', 'AGENT', 'SYSTEM'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
