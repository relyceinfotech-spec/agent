export const knownEntities = [
  "React Native",
  "React",
  "Flutter",
  "JavaScript",
  "TypeScript",
  "Python",
  "Node.js",
  "Next.js",
  "Vue",
  "Angular",
  "Svelte",
  "Bun",
  "Deno",
  "Docker",
  "Kubernetes",
  "PostgreSQL",
  "MySQL",
  "MongoDB",
  "Redis",
  "Tailwind CSS",
  "GraphQL",
  "FastAPI",
  "Django",
  "Express",
  "Supabase",
  "Firebase",
  "OpenAI",
  "Apple",
  "Microsoft",
  "NocoDB",
  "Rust",
  "Go",
  "Java",
  "Kotlin",
  "Swift",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function entityPattern(entity: string, global = false): RegExp {
  return new RegExp(
    `(^|[^a-zA-Z0-9])${escapeRegExp(entity)}(?=$|[^a-zA-Z0-9])`,
    global ? "gi" : "i",
  );
}

function candidateEntities(text: string): string[] {
  const entities = new Set(extractKnownEntities(text));
  const domains = text.match(/(?:[a-z0-9-]+\.)+[a-z]{2,}/gi) ?? [];
  const compoundEntities = knownEntities.filter((entity) => /\s/.test(entity));

  for (const domain of domains) {
    const labels = domain.toLowerCase().split(".");
    for (const entity of compoundEntities) {
      const compactEntity = entity.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (labels.some((label) => label.replace(/[^a-z0-9]/g, "") === compactEntity)) {
        entities.add(entity);
      }
    }
  }

  return [...entities];
}

/** Find catalogued entities, preferring a specific compound entity to its base name. */
export function extractKnownEntities(text: string): string[] {
  const matches = knownEntities.filter((entity) => entityPattern(entity).test(text));

  return matches.filter((entity) => {
    const containingEntities = matches.filter(
      (other) => other !== entity && other.toLowerCase().startsWith(`${entity.toLowerCase()} `),
    );
    if (containingEntities.length === 0) return true;

    const remainingText = containingEntities.reduce(
      (value, other) => value.replace(entityPattern(other, true), " "),
      text,
    );
    return entityPattern(entity).test(remainingText);
  });
}

/** Reject a more-specific sibling product when the request names only its parent entity. */
export function subjectEntityMismatchReason(
  requestedText: string,
  candidateText: string,
): string | undefined {
  const requested = extractKnownEntities(requestedText);
  const candidates = candidateEntities(candidateText);
  if (requested.length === 0 || candidates.length === 0) return undefined;

  const moreSpecific = candidates.find((candidate) =>
    requested.some(
      (entity) =>
        !requested.includes(candidate) &&
        candidate.toLowerCase().startsWith(`${entity.toLowerCase()} `),
    ),
  );
  if (moreSpecific) {
    const parent = requested.find((entity) =>
      moreSpecific.toLowerCase().startsWith(`${entity.toLowerCase()} `),
    );
    if (parent) {
      return `Candidate names ${moreSpecific}, a more-specific entity than the requested ${parent}.`;
    }
  }

  return undefined;
}

export function containsExactEntity(text: string, entity: string): boolean {
  if (knownEntities.includes(entity)) return extractKnownEntities(text).includes(entity);
  return entityPattern(entity).test(text);
}
