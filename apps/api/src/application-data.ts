import * as cheerio from "cheerio";

const MAX_APPLICATION_TEXT_CHARS = 12_000;
const MAX_JSON_DEPTH = 6;
const MAX_JSON_NODES = 800;
const MAX_OBJECT_FIELDS = 48;
const MAX_CONTEXT_FIELDS = 18;
const MAX_EMBEDDED_JSON_DOCUMENTS = 8;
const MAX_EMBEDDED_JSON_BYTES = 96_000;

export interface StructuredPersonRoleFact {
  sourceFormat: "json-ld";
  sourceUrl: string;
  entity: string;
  person: string;
  relationship: string;
  jobTitle: string;
  statement: string;
}

const sensitiveField =
  /(?:access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|passwd|authorization|cookie|credential|csrf|session|private[_-]?key|e-?mail|phone|mobile|telephone)/i;
const nonContentField =
  /^(?:id|uuid|guid|slug|href|src|url|image|icon|class|className|style|color|font|analytics|tracking|telemetry|createdAt|updatedAt|timestamp)$/i;

function safeFieldName(value: string): boolean {
  return value.length <= 80 && !sensitiveField.test(value) && !nonContentField.test(value);
}

function cleanPublicText(value: string): string {
  return value
    .replace(/<\/?(?:script|style|iframe|object|embed|svg)\b[^>]*>/gi, " ")
    .replace(/<[^>]{1,300}>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_500);
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const cleaned = cleanPublicText(value);
    if (cleaned.length < 2 || /^https?:\/\//i.test(cleaned)) return undefined;
    return cleaned;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Turns bounded, publicly delivered JSON into source-derived text while
 * retaining object/parent context for later entity and predicate checks.
 */
export function extractPublicApplicationData(raw: string): string | undefined {
  if (!raw.trim() || Buffer.byteLength(raw, "utf8") > MAX_EMBEDDED_JSON_BYTES) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\)\]\}',?\s*/, ""));
  } catch {
    return undefined;
  }

  const lines: string[] = [];
  let visited = 0;
  let totalChars = 0;

  const visit = (
    value: unknown,
    path: string[],
    inheritedFields: string[],
    depth: number,
  ): void => {
    if (
      depth > MAX_JSON_DEPTH ||
      visited >= MAX_JSON_NODES ||
      totalChars >= MAX_APPLICATION_TEXT_CHARS
    )
      return;
    visited += 1;

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 32)) visit(item, path, inheritedFields, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const localFields: string[] = [];
    const children: Array<[string, unknown]> = [];
    for (const [key, fieldValue] of Object.entries(record).slice(0, MAX_OBJECT_FIELDS)) {
      if (!safeFieldName(key)) continue;
      const primitive = scalarText(fieldValue);
      if (primitive !== undefined) {
        localFields.push(`${[...path, key].join(".")}: ${primitive}`);
        continue;
      }
      if (Array.isArray(fieldValue)) {
        const values = fieldValue
          .slice(0, 12)
          .map(scalarText)
          .filter((item): item is string => Boolean(item));
        if (values.length) {
          localFields.push(`${[...path, key].join(".")}: ${values.join(", ")}`);
        } else {
          children.push([key, fieldValue]);
        }
        continue;
      }
      if (fieldValue && typeof fieldValue === "object") children.push([key, fieldValue]);
    }

    const context = [...inheritedFields, ...localFields].slice(-MAX_CONTEXT_FIELDS);
    if (localFields.length && context.length) {
      const line = context.join("; ").slice(0, 2_000);
      if (line.length >= 24 && totalChars + line.length <= MAX_APPLICATION_TEXT_CHARS) {
        lines.push(line);
        totalChars += line.length;
      }
    }

    for (const [key, child] of children) {
      if (!safeFieldName(key)) continue;
      visit(child, [...path, key], context, depth + 1);
    }
  };

  visit(parsed, [], [], 0);
  const result = [...new Set(lines)].join("\n").trim();
  return result.length >= 24 ? result : undefined;
}

/** Parse well-known JSON hydration containers without executing page scripts. */
export function extractEmbeddedApplicationData(html: string, includeJsonLd = true): string[] {
  const $ = cheerio.load(html);
  const selector = includeJsonLd
    ? "script[type='application/json'],script[type='application/ld+json'],script#__NEXT_DATA__,script#__NUXT_DATA__,script#__INITIAL_STATE__"
    : "script[type='application/json']:not([type='application/ld+json']),script#__NEXT_DATA__,script#__NUXT_DATA__,script#__INITIAL_STATE__";
  const documents: string[] = [];
  let bytesRead = 0;

  $(selector)
    .slice(0, MAX_EMBEDDED_JSON_DOCUMENTS)
    .each((_index, element) => {
      const raw = $(element).contents().text().trim();
      const size = Buffer.byteLength(raw, "utf8");
      if (!raw || size > MAX_EMBEDDED_JSON_BYTES || bytesRead + size > MAX_EMBEDDED_JSON_BYTES)
        return;
      bytesRead += size;
      const extracted = extractPublicApplicationData(raw);
      if (extracted) documents.push(extracted);
    });

  return documents;
}

function jsonLdLocalName(key: string): string {
  return (
    key
      .replace(/^@/, "")
      .split(/[\/#:]/)
      .filter(Boolean)
      .at(-1)
      ?.toLowerCase() ?? ""
  );
}

function jsonLdValue(record: Record<string, unknown>, name: string): unknown {
  const exact = record[name];
  if (exact !== undefined) return exact;
  return Object.entries(record).find(([key]) => jsonLdLocalName(key) === name.toLowerCase())?.[1];
}

function jsonLdStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => {
      if (typeof item === "string") return cleanPublicText(item);
      return typeof item === "number" && Number.isFinite(item) ? String(item) : undefined;
    })
    .filter((item): item is string => Boolean(item))
    .slice(0, 8);
}

function indexJsonLdNodes(value: unknown): Map<string, Record<string, unknown>> {
  const nodes = new Map<string, Record<string, unknown>>();
  let visited = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH || visited >= MAX_JSON_NODES) return;
    visited += 1;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 32)) visit(item, depth + 1);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    const id = jsonLdStrings(jsonLdValue(record, "@id"))[0];
    if (id) {
      const previous = nodes.get(id);
      const currentFieldCount = Object.keys(record).length;
      if (!previous || currentFieldCount > Object.keys(previous).length) nodes.set(id, record);
    }
    for (const child of Object.values(record).slice(0, MAX_OBJECT_FIELDS)) visit(child, depth + 1);
  };
  visit(value, 0);
  return nodes;
}

function resolvedJsonLdRecord(
  value: unknown,
  nodes: Map<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = jsonLdStrings(jsonLdValue(record, "@id"))[0];
  const target = id ? nodes.get(id) : undefined;
  const containsPersonEvidence =
    jsonLdValue(record, "name") !== undefined || jsonLdValue(record, "jobTitle") !== undefined;
  if (target && !containsPersonEvidence) return { ...target, ...record };
  return record;
}

const organizationPersonRelations = new Map([
  ["employee", "employee"],
  ["employees", "employee"],
  ["founder", "founder"],
  ["founders", "founder"],
  ["member", "member"],
  ["members", "member"],
  ["memberof", "member of"],
  ["worksfor", "works for"],
  ["worksat", "works at"],
  ["affiliation", "affiliation"],
  ["affiliations", "affiliation"],
  ["leadership", "leadership"],
  ["executive", "executive"],
  ["executives", "executive"],
  ["boardmember", "board member"],
  ["boardmembers", "board member"],
  ["director", "director"],
  ["directors", "director"],
  ["president", "president"],
]);

function isOrganization(record: Record<string, unknown>): boolean {
  return jsonLdStrings(jsonLdValue(record, "@type")).some((type) => {
    const normalized = jsonLdLocalName(type);
    return (
      normalized === "organization" ||
      normalized === "corporation" ||
      normalized.endsWith("organization") ||
      normalized === "localbusiness"
    );
  });
}

function isPerson(record: Record<string, unknown>): boolean {
  const typedPerson = jsonLdStrings(jsonLdValue(record, "@type")).some(
    (type) => jsonLdLocalName(type) === "person",
  );
  return (
    typedPerson ||
    (jsonLdStrings(jsonLdValue(record, "name")).length > 0 &&
      jsonLdStrings(jsonLdValue(record, "jobTitle")).length > 0)
  );
}

function relatedPeople(
  value: unknown,
  nodes: Map<string, Record<string, unknown>>,
  depth = 0,
  seen = new Set<Record<string, unknown>>(),
): Record<string, unknown>[] {
  if (depth > 5) return [];
  if (Array.isArray(value))
    return value.slice(0, 32).flatMap((item) => relatedPeople(item, nodes, depth + 1, seen));
  const record = resolvedJsonLdRecord(value, nodes);
  if (!record || seen.has(record)) return [];
  seen.add(record);
  if (isPerson(record)) return [record];
  return Object.values(record)
    .slice(0, MAX_OBJECT_FIELDS)
    .flatMap((child) =>
      child && typeof child === "object" ? relatedPeople(child, nodes, depth + 1, seen) : [],
    );
}

/**
 * Normalize only explicit JSON-LD organization-to-person role relationships.
 * Descriptions and disconnected graph nodes remain available as ordinary page
 * text, but cannot masquerade as a person's job title.
 */
export function extractEmbeddedStructuredData(
  html: string,
  sourceUrl: string,
): { present: boolean; facts: StructuredPersonRoleFact[] } {
  const $ = cheerio.load(html);
  const scripts = $("script[type='application/ld+json']").slice(0, MAX_EMBEDDED_JSON_DOCUMENTS);
  if (!scripts.length) return { present: false, facts: [] };
  let bytesRead = 0;
  const parsedDocuments: unknown[] = [];
  scripts.each((_index, element) => {
    const raw = $(element).contents().text().trim();
    const size = Buffer.byteLength(raw, "utf8");
    if (!raw || size > MAX_EMBEDDED_JSON_BYTES || bytesRead + size > MAX_EMBEDDED_JSON_BYTES)
      return;
    bytesRead += size;
    try {
      parsedDocuments.push(JSON.parse(raw.replace(/^\)\]\}',?\s*/, "")) as unknown);
    } catch {
      // Invalid JSON-LD is not evidence, but does not interrupt other scripts.
    }
  });
  if (!parsedDocuments.length) return { present: false, facts: [] };

  const facts: StructuredPersonRoleFact[] = [];
  const seenFacts = new Set<string>();
  for (const parsed of parsedDocuments) {
    const nodes = indexJsonLdNodes(parsed);
    const candidates: Record<string, unknown>[] = [];
    const collect = (value: unknown, depth = 0): void => {
      if (depth > MAX_JSON_DEPTH) return;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 32)) collect(item, depth + 1);
      } else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (isOrganization(record)) candidates.push(record);
        for (const child of Object.values(record).slice(0, MAX_OBJECT_FIELDS))
          collect(child, depth + 1);
      }
    };
    collect(parsed);

    for (const organization of candidates.slice(0, 32)) {
      const entity = jsonLdStrings(jsonLdValue(organization, "name"))[0];
      if (!entity) continue;
      for (const [key, relatedValue] of Object.entries(organization).slice(0, MAX_OBJECT_FIELDS)) {
        const relation = organizationPersonRelations.get(jsonLdLocalName(key));
        if (!relation || !relatedValue || typeof relatedValue !== "object") continue;
        for (const personRecord of relatedPeople(relatedValue, nodes)) {
          const person = jsonLdStrings(jsonLdValue(personRecord, "name"))[0];
          const titles = jsonLdStrings(jsonLdValue(personRecord, "jobTitle"));
          if (!person || !titles.length) continue;
          for (const jobTitle of titles) {
            const statement = `Structured JSON-LD links ${person} to ${entity} through the ${relation} relationship and lists the person's job title as ${jobTitle}.`;
            const key = `${entity.toLowerCase()}|${person.toLowerCase()}|${relation}|${jobTitle.toLowerCase()}|${sourceUrl}`;
            if (seenFacts.has(key)) continue;
            seenFacts.add(key);
            facts.push({
              sourceFormat: "json-ld",
              sourceUrl,
              entity,
              person,
              relationship: relation,
              jobTitle,
              statement,
            });
          }
        }
      }
    }
  }
  return { present: true, facts: facts.slice(0, 64) };
}

export function isStructuredPersonRoleFact(value: unknown): value is StructuredPersonRoleFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fact = value as Partial<StructuredPersonRoleFact>;
  if (
    fact.sourceFormat !== "json-ld" ||
    typeof fact.sourceUrl !== "string" ||
    typeof fact.entity !== "string" ||
    typeof fact.person !== "string" ||
    typeof fact.relationship !== "string" ||
    typeof fact.jobTitle !== "string" ||
    typeof fact.statement !== "string" ||
    fact.sourceUrl.length > 2048 ||
    fact.entity.length > 300 ||
    fact.person.length > 300 ||
    fact.relationship.length > 80 ||
    fact.jobTitle.length > 500 ||
    fact.statement.length > 1600
  ) {
    return false;
  }
  try {
    const url = new URL(fact.sourceUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
