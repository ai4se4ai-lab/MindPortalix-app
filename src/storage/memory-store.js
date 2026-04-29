export class InMemoryMemoryStore {
  #records;

  constructor(initialRecords = []) {
    this.#records = initialRecords.map((record) => normalizeRecord(record));
  }

  async search({ userId, query, limit = 5 }) {
    const terms = tokenize(query);
    return this.#records
      .filter((record) => record.userId === userId)
      .map((record) => ({
        ...record,
        relevance: relevanceScore(record, terms)
      }))
      .filter((record) => record.relevance > 0)
      .sort((left, right) => right.relevance - left.relevance || right.importance - left.importance)
      .slice(0, limit);
  }

  async write(record) {
    const normalized = normalizeRecord(record);
    this.#records.push(normalized);
    return normalized;
  }

  async all(userId) {
    return this.#records.filter((record) => record.userId === userId);
  }
}

export function summarizeForMemory({ userId, topic = "session", messages = [], importance = 3 }) {
  const content = messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

  return normalizeRecord({
    userId,
    topic,
    summary: content.length > 420 ? `${content.slice(0, 417)}...` : content,
    importance
  });
}

function normalizeRecord(record) {
  if (!record?.userId) {
    throw new Error("Memory records require userId");
  }

  return {
    id: record.id ?? cryptoSafeId(),
    userId: record.userId,
    topic: record.topic ?? "general",
    summary: record.summary ?? "",
    importance: Number.isFinite(record.importance) ? record.importance : 3,
    createdAt: record.createdAt ?? new Date().toISOString(),
    lastAccessed: record.lastAccessed ?? new Date().toISOString()
  };
}

function relevanceScore(record, terms) {
  const haystack = `${record.topic} ${record.summary}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) + record.importance / 10;
}

function tokenize(query) {
  return String(query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
}

function cryptoSafeId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
